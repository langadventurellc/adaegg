import { describe, expect, it } from "vitest";
import type { ListedWorkItem } from "../engine/store.ts";
import { summarizeQueue, titleFromText } from "./queue.ts";

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
