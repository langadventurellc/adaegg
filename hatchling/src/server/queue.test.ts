import { describe, expect, it } from "vitest";
import { EXHAUSTED_ROUNDS_PREFIX } from "../engine/nodes/enqueue.ts";
import type { ListedWorkItem } from "../engine/store.ts";
import { deliveryOf, summarizeQueue, titleFromText } from "./queue.ts";

let seq = 0;
function item(over: Partial<ListedWorkItem>): ListedWorkItem {
  seq++;
  return {
    id: `id-${seq}`,
    title: `t${seq}`,
    contents: "",
    kind: "item",
    status: "queued",
    priority: 0,
    parentId: null,
    sourceId: null,
    error: null,
    createdAt: `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    blockedBy: [],
    ...over,
  };
}

describe("titleFromText", () => {
  it("takes the first non-empty line with whitespace collapsed", () => {
    expect(titleFromText("\n  \n  Add   a\tdark  mode \nmore detail")).toBe("Add a dark mode");
  });

  it("keeps 80 characters and cuts longer text to 79 plus an ellipsis", () => {
    expect(titleFromText("a".repeat(80))).toBe("a".repeat(80));
    const cut = titleFromText("a".repeat(81));
    expect(cut).toBe(`${"a".repeat(79)}…`);
    expect([...cut]).toHaveLength(80);
  });

  it("counts code points", () => {
    expect([...titleFromText("😀".repeat(100))]).toHaveLength(80);
  });

  it("gives an empty title for blank text", () => {
    expect(titleFromText("")).toBe("");
    expect(titleFromText(" \n\t\n  ")).toBe("");
  });
});

describe("summarizeQueue", () => {
  it("counts every status, zeros included", () => {
    const summary = summarizeQueue([item({ status: "done" }), item({ status: "done" }), item({ status: "failed" })]);
    expect(summary.counts).toEqual({ queued: 0, in_progress: 0, done: 2, failed: 1, cancelled: 0 });
  });

  it("lists only top-level request and item rows", () => {
    const parent = item({ kind: "request" });
    const summary = summarizeQueue([
      parent,
      item({ parentId: parent.id }),
      item({ kind: "verify" }),
      item({ kind: "other" }),
      item({ kind: "item" }),
    ]);
    expect(summary.requests.map((r) => r.kind).sort()).toEqual(["item", "request"]);
  });

  it("puts the newest first, later-listed first on ties, capped at 20", () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      item({ id: `n${i}`, createdAt: `2026-01-01T00:00:${String(Math.floor(i / 2)).padStart(2, "0")}.000Z` }),
    );
    const { requests } = summarizeQueue(items);
    expect(requests).toHaveLength(20);
    expect(requests[0]?.id).toBe("n24");
    expect(requests[1]?.id).toBe("n23");
    expect(requests[2]?.id).toBe("n22");
  });

  it("computes progress from item children and ignores verify children", () => {
    const parent = item({ kind: "request", blockedBy: ["x"], error: "boom" });
    const summary = summarizeQueue([
      parent,
      item({ parentId: parent.id, status: "done" }),
      item({ parentId: parent.id, status: "queued" }),
      item({ parentId: parent.id, kind: "verify", status: "done" }),
    ]);
    const row = summary.requests[0];
    expect(row?.progress).toEqual({ done: 1, total: 2 });
    expect(row?.blockedBy).toEqual(["x"]);
    expect(row?.error).toBe("boom");
    expect(row?.id).toBe(parent.id);
  });

  it("gives null progress without item children", () => {
    const parent = item({ kind: "request" });
    const summary = summarizeQueue([parent, item({ parentId: parent.id, kind: "verify" })]);
    expect(summary.requests[0]?.progress).toBeNull();
  });
});

describe("deliveryOf", () => {
  const parentOf = (status: ListedWorkItem["status"], over: Partial<ListedWorkItem> = {}) =>
    item({ kind: "request", status, ...over });
  const step = (p: ListedWorkItem, over: Partial<ListedWorkItem> = {}) =>
    item({ parentId: p.id, kind: "item", ...over });
  const verify = (p: ListedWorkItem, over: Partial<ListedWorkItem> = {}) =>
    item({ parentId: p.id, kind: "verify", ...over });

  it("is planning while the parent is queued or in progress", () => {
    expect(deliveryOf(parentOf("queued"), [])).toEqual({ state: "planning", attention: null });
    expect(deliveryOf(parentOf("in_progress"), [])).toEqual({ state: "planning", attention: null });
  });

  it("keeps failed and cancelled parents as they are", () => {
    const failed = parentOf("failed", { error: "boom" });
    expect(deliveryOf(failed, [])).toEqual({
      state: "failed",
      attention: { id: failed.id, title: failed.title, error: "boom", action: "retry" },
    });
    const cancelled = parentOf("cancelled", { error: "ignored" });
    expect(deliveryOf(cancelled, [])).toEqual({
      state: "cancelled",
      attention: { id: cancelled.id, title: cancelled.title, error: null, action: "retry" },
    });
  });

  it("is building while a step is queued, verifying when only verifications remain", () => {
    const p = parentOf("done");
    expect(deliveryOf(p, [step(p, { status: "done" }), step(p, { status: "queued" })]).state).toBe("building");
    expect(deliveryOf(p, [step(p, { status: "done" }), verify(p, { status: "queued" })]).state).toBe("verifying");
    expect(deliveryOf(p, [step(p, { status: "done" }), verify(p, { status: "in_progress" })]).state).toBe("verifying");
  });

  it("needs attention for a failed step even when another step runs", () => {
    const p = parentOf("done");
    const bad = step(p, { status: "failed", error: "nope" });
    const d = deliveryOf(p, [step(p, { status: "in_progress" }), bad, verify(p, { status: "queued" })]);
    expect(d).toEqual({
      state: "needs-attention",
      attention: { id: bad.id, title: bad.title, error: "nope", action: "retry" },
    });
  });

  it("needs attention for a cancelled step with a null error", () => {
    const p = parentOf("done");
    const bad = step(p, { status: "cancelled" });
    expect(deliveryOf(p, [bad]).attention).toEqual({ id: bad.id, title: bad.title, error: null, action: "retry" });
  });

  it("retries a verify with an ordinary error", () => {
    const p = parentOf("done");
    const v = verify(p, { status: "failed", error: "not signed in" });
    expect(deliveryOf(p, [step(p, { status: "done" }), v])).toEqual({
      state: "needs-attention",
      attention: { id: v.id, title: v.title, error: "not signed in", action: "retry" },
    });
  });

  it("is incomplete when verification ran out of rounds", () => {
    const p = parentOf("done");
    const v = verify(p, {
      status: "failed",
      error: `${EXHAUSTED_ROUNDS_PREFIX} 2 verification rounds (maxVerifyRounds).`,
    });
    const d = deliveryOf(p, [step(p, { status: "done" }), v]);
    expect(d.state).toBe("incomplete");
    expect(d.attention).toMatchObject({ id: v.id, action: "ask-again" });
  });

  it("is delivered when everything is done or there is nothing to do", () => {
    const p = parentOf("done");
    expect(deliveryOf(p, [step(p, { status: "done" }), verify(p, { status: "done" })])).toEqual({
      state: "delivered",
      attention: null,
    });
    expect(deliveryOf(p, []).state).toBe("delivered");
    expect(deliveryOf(p, [step(p, { status: "done" })]).state).toBe("delivered");
  });

  it("is set on request rows and null on top-level items", () => {
    const req = parentOf("done");
    const plain = item({ kind: "item" });
    const rows = summarizeQueue([req, plain, step(req, { status: "queued" })]).requests;
    expect(rows.find((r) => r.id === req.id)?.delivery?.state).toBe("building");
    expect(rows.find((r) => r.id === plain.id)?.delivery).toBeNull();
  });
});

describe("summarizeQueue followUp", () => {
  const request = (over: Partial<ListedWorkItem> = {}) => item({ kind: "request", status: "done", ...over });
  const step = (p: ListedWorkItem, over: Partial<ListedWorkItem> = {}) =>
    item({ parentId: p.id, kind: "item", ...over });
  const verify = (p: ListedWorkItem, over: Partial<ListedWorkItem> = {}) =>
    item({ parentId: p.id, kind: "verify", ...over });
  const continuation = (original: ListedWorkItem, over: Partial<ListedWorkItem> = {}) =>
    request({ contents: `Finish the request ${original.id.slice(0, 8)} "x"…`, status: "queued", ...over });
  const rowOf = (items: ListedWorkItem[], id: string) => {
    const row = summarizeQueue(items).requests.find((r) => r.id === id);
    if (row === undefined) throw new Error("no row");
    return row;
  };

  it("is null without a follow-up", () => {
    const original = request();
    expect(rowOf([original], original.id).followUp).toBeNull();
  });

  it("shows a queued, planning, building and delivered follow-up", () => {
    const original = request();
    const queued = continuation(original);
    expect(rowOf([original, queued], original.id).followUp).toEqual({
      id: queued.id,
      title: queued.title,
      status: "queued",
      blockedBy: [],
      progress: null,
      delivery: { state: "planning", attention: null },
    });

    const planning = continuation(original, { status: "in_progress" });
    expect(rowOf([original, planning], original.id).followUp?.delivery.state).toBe("planning");

    const building = continuation(original, { status: "done" });
    const kids = [step(building, { status: "done" }), step(building, { status: "queued" })];
    const built = rowOf([original, building, ...kids], original.id).followUp;
    expect(built?.delivery.state).toBe("building");
    expect(built?.progress).toEqual({ done: 1, total: 2 });

    const delivered = continuation(original, { status: "done" });
    const done = [step(delivered, { status: "done" }), step(delivered, { status: "done" })];
    const result = rowOf([original, delivered, ...done], original.id).followUp;
    expect(result?.delivery.state).toBe("delivered");
    expect(result?.progress).toEqual({ done: 2, total: 2 });
  });

  it("ignores a failed or cancelled follow-up and picks a later live one", () => {
    const original = request();
    const failed = continuation(original, { status: "failed", error: "boom" });
    const cancelled = continuation(original, { status: "cancelled" });
    expect(rowOf([original, failed, cancelled], original.id).followUp).toBeNull();
    const live = continuation(original);
    expect(rowOf([original, failed, live], original.id).followUp?.id).toBe(live.id);
  });

  it("is null on a top-level item", () => {
    const plain = item({ kind: "item" });
    expect(rowOf([plain], plain.id).followUp).toBeNull();
  });

  it("leaves the original row's own fields unchanged", () => {
    const original = request();
    const kids = [
      step(original, { status: "done" }),
      verify(original, { status: "failed", error: `${EXHAUSTED_ROUNDS_PREFIX} 2 verification rounds.` }),
    ];
    const without = rowOf([original, ...kids], original.id);
    const followUp = continuation(original);
    const withFollowUp = rowOf([original, ...kids, followUp], original.id);
    expect(withFollowUp.delivery).toEqual(without.delivery);
    expect(withFollowUp.progress).toEqual(without.progress);
    expect(withFollowUp.status).toEqual(without.status);
    expect(withFollowUp.delivery?.state).toBe("incomplete");
    expect(withFollowUp.followUp?.id).toBe(followUp.id);
  });
});
