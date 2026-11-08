import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import {
  addWorkItem,
  cancelWorkItem,
  claimNext,
  failWorkItem,
  finishWorkItem,
  getWorkItem,
  listWorkItems,
  retryWorkItem,
} from "./store.ts";

let db: DatabaseSync;
beforeEach(() => {
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

  it("rejects a missing blocker and a self-block", () => {
    expect(() => addWorkItem(db, { title: "x", blockedBy: ["nonexistent"] })).toThrow("blocker not found: nonexistent");
    expect(listWorkItems(db)).toEqual([]);
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
