import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { createRun, getRun, listNodeRuns, listRunningRuns, listRuns, listRunsForItem } from "./runs.ts";
import { addWorkItem } from "./store.ts";
import type { Workflow } from "./workflows/schema.ts";

const workflow: Workflow = {
  id: "w",
  name: "W",
  trigger: { type: "queue", kind: "item" },
  start: "a",
  nodes: [{ id: "a", type: "t", config: {} }],
  edges: [{ from: "a", on: "ok", to: "end" }],
};

let db: DatabaseSync;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("run store", () => {
  it("creates a running run at the start node with default state", () => {
    const item = addWorkItem(db, { title: "x" });
    const run = createRun(db, item, workflow);
    expect(run.status).toBe("running");
    expect(run.currentNode).toBe("a");
    expect(run.workItemId).toBe(item.id);
    expect(run.state.edgeCounts).toEqual({});
    expect(run.state.branch).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(getRun(db, run.id)).toEqual(run);
  });

  it("throws for an unknown run", () => {
    expect(() => getRun(db, "nope")).toThrow("no run matches nope");
  });

  it("lists running runs, runs newest first, and runs per item", () => {
    const a = addWorkItem(db, { title: "a" });
    const b = addWorkItem(db, { title: "b" });
    const r1 = createRun(db, a, workflow);
    const r2 = createRun(db, b, workflow);
    const r3 = createRun(db, a, workflow);
    db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(r2.id);

    expect(listRunningRuns(db).map((r) => r.id)).toEqual([r1.id, r3.id]);
    expect(listRuns(db, { limit: 10 }).map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
    expect(listRuns(db, { limit: 2 })).toHaveLength(2);
    expect(listRunsForItem(db, a.id).map((r) => r.id)).toEqual([r1.id, r3.id]);
  });

  it("lists node runs in insertion order", () => {
    const run = createRun(db, addWorkItem(db, { title: "a" }), workflow);
    const insert = db.prepare(
      "INSERT INTO node_runs (run_id, node_id, attempt, outcome, cost_usd, input_tokens, started_at) VALUES (?, ?, ?, ?, ?, ?, 'x')",
    );
    insert.run(run.id, "a", 1, "ok", 0.5, 10);
    insert.run(run.id, "b", 1, null, null, null);
    const rows = listNodeRuns(db, run.id);
    expect(rows.map((r) => r.nodeId)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ outcome: "ok", costUsd: 0.5, inputTokens: 10, outputTokens: null, problem: null });
    expect(rows[1]?.outcome).toBeNull();
  });
});
