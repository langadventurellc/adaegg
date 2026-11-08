import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "./db.ts";
import {
  addWorkItem,
  cancelWorkItem,
  claimNext,
  failWorkItem,
  finishWorkItem,
  getWorkItem,
  hasItemsFromSource,
  listWorkItems,
  markReverted,
  retryWorkItem,
} from "./store.ts";

// A nonempty value makes randomUUID return it, so a test can aim a blocker at the new id.
let nextUuid = "";
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => (nextUuid === "" ? actual.randomUUID() : nextUuid) };
});

let db: DatabaseSync;
beforeEach(() => {
  nextUuid = "";
  db = openDb(":memory:");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function snapshot(): unknown[] {
  return db.prepare("SELECT id, status, updated_at FROM work_items ORDER BY rowid").all();
}

function insertRaw(id: string): void {
  db.prepare("INSERT INTO work_items (id, title, created_at, updated_at) VALUES (?, 't', 'x', 'x')").run(id);
}

describe("add and list", () => {
  it("adds and lists in creation order", () => {
    const a = addWorkItem(db, { title: "a", contents: "body" });
    const b = addWorkItem(db, { title: "b", priority: 3, kind: "k" });
    expect(a).toMatchObject({ title: "a", contents: "body", kind: "item", status: "queued", priority: 0 });
    expect(b).toMatchObject({ kind: "k", priority: 3 });
    expect(listWorkItems(db).map((i) => i.id)).toEqual([a.id, b.id]);
    expect(listWorkItems(db, { status: "done" })).toEqual([]);
  });

  it("resolves blockers and parent by prefix", () => {
    const a = addWorkItem(db, { title: "a" });
    const b = addWorkItem(db, { title: "b", blockedBy: [a.id.slice(0, 6)], parentId: a.id.slice(0, 6) });
    expect(b.parentId).toBe(a.id);
    expect(listWorkItems(db)[1]?.blockedBy).toEqual([a.id]);
  });

  it("round-trips sourceId, resolving a prefix, and defaults it to null", () => {
    const a = addWorkItem(db, { title: "a" });
    expect(a.sourceId).toBeNull();
    const b = addWorkItem(db, { title: "b", sourceId: a.id.slice(0, 6) });
    expect(b.sourceId).toBe(a.id);
    expect(getWorkItem(db, b.id).sourceId).toBe(a.id);
    expect(listWorkItems(db).map((i) => i.sourceId)).toEqual([null, a.id]);
  });

  it("rejects an unknown source", () => {
    expect(() => addWorkItem(db, { title: "x", sourceId: "nonexistent" })).toThrow("no work item matches nonexistent");
    expect(listWorkItems(db)).toEqual([]);
  });

  it("hasItemsFromSource is true only for a source that created items", () => {
    const a = addWorkItem(db, { title: "a" });
    const other = addWorkItem(db, { title: "other" });
    expect(hasItemsFromSource(db, a.id)).toBe(false);
    addWorkItem(db, { title: "b", sourceId: a.id });
    expect(hasItemsFromSource(db, a.id)).toBe(true);
    expect(hasItemsFromSource(db, other.id)).toBe(false);
  });

  it("rejects a missing blocker", () => {
    expect(() => addWorkItem(db, { title: "x", blockedBy: ["nonexistent"] })).toThrow("blocker not found: nonexistent");
    expect(listWorkItems(db)).toEqual([]);
  });

  it("rejects a self-block and leaves no item or edge", () => {
    nextUuid = "11112222-3333-4444-5555-666677778888";
    expect(() => addWorkItem(db, { title: "x", blockedBy: [nextUuid] })).toThrow("cannot block itself");
    expect(() => addWorkItem(db, { title: "x", blockedBy: ["1111222"] })).toThrow("cannot block itself");
    expect(listWorkItems(db)).toEqual([]);
    expect(db.prepare("SELECT * FROM work_item_blocks").all()).toEqual([]);
  });

  it("resolves an existing prefix that the new id also starts with", () => {
    insertRaw("abcd1111-0000");
    nextUuid = "abcd2222-3333-4444-5555-666677778888";
    const b = addWorkItem(db, { title: "x", blockedBy: ["abcd"] });
    expect(listWorkItems(db).find((i) => i.id === b.id)?.blockedBy).toEqual(["abcd1111-0000"]);
  });

  it("reports ambiguity, not a self-block, when existing items share the prefix", () => {
    insertRaw("abcd1111-0000");
    insertRaw("abcd3333-0000");
    nextUuid = "abcd2222-3333-4444-5555-666677778888";
    expect(() => addWorkItem(db, { title: "x", blockedBy: ["abcd"] })).toThrow("ambiguous id prefix abcd");
  });

  it("keeps the too-short and ambiguous explanations for blockers", () => {
    insertRaw("abcd1111-0000");
    insertRaw("abcd2222-0000");
    expect(() => addWorkItem(db, { title: "x", blockedBy: ["abc"] })).toThrow("id prefix too short: abc");
    expect(() => addWorkItem(db, { title: "x", blockedBy: ["abcd"] })).toThrow("ambiguous id prefix abcd");
    expect(db.prepare("SELECT id FROM work_items").all()).toHaveLength(2);
    expect(db.prepare("SELECT * FROM work_item_blocks").all()).toEqual([]);
  });
});

describe("claimNext", () => {
  it("orders by priority then age", () => {
    const old = addWorkItem(db, { title: "old" });
    const young = addWorkItem(db, { title: "young" });
    const high = addWorkItem(db, { title: "high", priority: 5 });
    expect(claimNext(db, "item")?.id).toBe(high.id);
    expect(claimNext(db, "item")?.id).toBe(old.id);
    expect(claimNext(db, "item")?.id).toBe(young.id);
    expect(claimNext(db, "item")).toBeNull();
  });

  it("only claims the requested kind and sets in_progress", () => {
    addWorkItem(db, { title: "a", kind: "other" });
    expect(claimNext(db, "item")).toBeNull();
    expect(claimNext(db, "other")?.status).toBe("in_progress");
  });

  it("skips blocked items until the blocker is done", () => {
    const a = addWorkItem(db, { title: "a" });
    const b = addWorkItem(db, { title: "b", blockedBy: [a.id], priority: 9 });
    expect(claimNext(db, "item")?.id).toBe(a.id);
    expect(claimNext(db, "item")).toBeNull();
    finishWorkItem(db, a.id);
    expect(listWorkItems(db)[1]?.blockedBy).toEqual([]);
    expect(claimNext(db, "item")?.id).toBe(b.id);
  });

  it("leaves dependants of a failed blocker queued and listed as blocked", () => {
    const a = addWorkItem(db, { title: "a" });
    const b = addWorkItem(db, { title: "b", blockedBy: [a.id] });
    claimNext(db, "item");
    failWorkItem(db, a.id, "boom");
    expect(claimNext(db, "item")).toBeNull();
    const listed = listWorkItems(db).find((i) => i.id === b.id);
    expect(listed?.status).toBe("queued");
    expect(listed?.blockedBy).toEqual([a.id]);
  });

  it("writes nothing on an empty or fully blocked queue", async () => {
    const empty = snapshot();
    expect(claimNext(db, "item")).toBeNull();
    expect(snapshot()).toEqual(empty);

    const a = addWorkItem(db, { title: "a" });
    addWorkItem(db, { title: "b", blockedBy: [a.id] });
    claimNext(db, "item");
    const before = snapshot();
    await sleep(5);
    expect(claimNext(db, "item")).toBeNull();
    expect(snapshot()).toEqual(before);
  });

  it("never returns the same item twice", () => {
    addWorkItem(db, { title: "a" });
    addWorkItem(db, { title: "b" });
    const first = claimNext(db, "item");
    const second = claimNext(db, "item");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
  });
});

describe("transitions", () => {
  it("cancels queued and retries cancelled", () => {
    const a = addWorkItem(db, { title: "a" });
    const cancelled = cancelWorkItem(db, a.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finishedAt).not.toBeNull();
    const retried = retryWorkItem(db, a.id.slice(0, 8));
    expect(retried.status).toBe("queued");
    expect(retried.finishedAt).toBeNull();
  });

  it("retry clears the error", () => {
    const a = addWorkItem(db, { title: "a" });
    claimNext(db, "item");
    const failed = failWorkItem(db, a.id, "boom");
    expect(failed).toMatchObject({ status: "failed", error: "boom" });
    expect(failed.finishedAt).not.toBeNull();
    expect(retryWorkItem(db, a.id)).toMatchObject({ status: "queued", error: null, finishedAt: null });
  });

  it("refuses other transitions", () => {
    const a = addWorkItem(db, { title: "a" });
    expect(() => retryWorkItem(db, a.id)).toThrow(`cannot retry ${a.id.slice(0, 8)}: status is queued`);
    claimNext(db, "item");
    expect(() => cancelWorkItem(db, a.id)).toThrow(
      `cannot cancel ${a.id.slice(0, 8)}: status is in_progress (only queued items can be cancelled)`,
    );
    expect(() => failWorkItem(db, "zzzz-none", "x")).toThrow("no work item matches zzzz-none");
    finishWorkItem(db, a.id);
    expect(getWorkItem(db, a.id)).toMatchObject({ status: "done" });
    expect(() => finishWorkItem(db, a.id)).toThrow("cannot finish");
  });

  it("marks a done item reverted: done -> failed with the error", () => {
    const a = addWorkItem(db, { title: "a" });
    claimNext(db, "item");
    finishWorkItem(db, a.id);
    const reverted = markReverted(db, a.id, "its merge was reverted");
    expect(reverted).toMatchObject({ status: "failed", error: "its merge was reverted" });
    expect(reverted.finishedAt).not.toBeNull();
  });

  it("refuses to mark queued, in_progress or failed items reverted", () => {
    const a = addWorkItem(db, { title: "a" });
    expect(() => markReverted(db, a.id, "x")).toThrow("only done items can be marked reverted");
    claimNext(db, "item");
    expect(() => markReverted(db, a.id, "x")).toThrow("status is in_progress");
    failWorkItem(db, a.id, "boom");
    expect(() => markReverted(db, a.id, "x")).toThrow("status is failed");
    expect(getWorkItem(db, a.id).error).toBe("boom");
  });
});

describe("prefix lookup", () => {
  it("handles exact, short, unknown and ambiguous prefixes", () => {
    insertRaw("abcd1111-0000");
    insertRaw("abcd2222-0000");
    insertRaw("ef");
    expect(getWorkItem(db, "ef").id).toBe("ef");
    expect(getWorkItem(db, "abcd1").id).toBe("abcd1111-0000");
    expect(() => getWorkItem(db, "abc")).toThrow("id prefix too short: abc (need at least 4 characters)");
    expect(() => getWorkItem(db, "zzzz")).toThrow("no work item matches zzzz");
    expect(() => getWorkItem(db, "abcd")).toThrow("ambiguous id prefix abcd: matches abcd1111, abcd2222");
  });
});
