import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigSchema } from "./config.ts";
import { openDb } from "./db.ts";
import { defineNode, type NodeContext, type NodeResult } from "./nodes/types.ts";
import { createRunner } from "./runner.ts";
import { getRun, listNodeRuns } from "./runs.ts";
import { addWorkItem, claimNext, getWorkItem, type WorkItem } from "./store.ts";
import type { Workflow } from "./workflows/schema.ts";

let db: DatabaseSync;
beforeEach(() => {
  db = openDb(":memory:");
});

type Fn = (ctx: NodeContext<unknown>) => Promise<NodeResult> | NodeResult;

function fake(outcomes: string[], fn: Fn) {
  return defineNode({
    type: "fake",
    outcomes,
    configSchema: z.object({}).passthrough(),
    run: async (ctx: NodeContext<unknown>) => fn(ctx),
  });
}

function setup(workflow: Workflow, nodes: Record<string, ReturnType<typeof fake>>) {
  const runner = createRunner({
    db,
    workflows: [workflow],
    nodeTypes: nodes,
    appConfig: ConfigSchema.parse({ schema: 1 }),
    paths: { root: "/r", stateDir: "/r/.adaegg" },
  });
  addWorkItem(db, { title: "do it" });
  const item = claimNext(db, "item") as WorkItem;
  return { runner, item };
}

function wf(nodes: string[], edges: Workflow["edges"], start = nodes[0] as string): Workflow {
  return {
    id: "w",
    name: "W",
    trigger: { type: "queue", kind: "item" },
    start,
    nodes: nodes.map((id) => ({ id, type: id, config: {} })),
    edges,
  };
}

describe("runner", () => {
  it("walks to end, merging state and recording node runs", async () => {
    const w = wf(
      ["a", "b"],
      [
        { from: "a", on: "ok", to: "b" },
        { from: "b", on: "ok", to: "end" },
      ],
    );
    const { runner, item } = setup(w, {
      a: fake(["ok"], () => ({
        outcome: "ok",
        state: { branch: "br" },
        costUsd: 0.25,
        tokens: { input: 5, output: 7 },
      })),
      b: fake(["ok"], (ctx) => {
        expect((ctx.state as { branch: string }).branch).toBe("br");
        return { outcome: "ok", state: { mergeCommit: "abc" } };
      }),
    });
    const run = await runner.startRun(item, w, new AbortController().signal);
    expect(run.status).toBe("succeeded");
    expect(run.finishedAt).not.toBeNull();
    expect(run.state.branch).toBe("br");
    expect(run.state.mergeCommit).toBe("abc");
    expect(run.state.edgeCounts).toEqual({ "a:ok": 1, "b:ok": 1 });
    expect(getWorkItem(db, item.id).status).toBe("done");
    const rows = listNodeRuns(db, run.id);
    expect(rows.map((r) => [r.nodeId, r.attempt, r.outcome])).toEqual([
      ["a", 1, "ok"],
      ["b", 1, "ok"],
    ]);
    expect(rows[0]).toMatchObject({ costUsd: 0.25, inputTokens: 5, outputTokens: 7 });
    expect(rows[0]?.finishedAt).not.toBeNull();
  });

  it("fails the run and item when a loop exceeds its max", async () => {
    const w = wf(
      ["a"],
      [
        { from: "a", on: "again", to: "a", max: 2 },
        { from: "a", on: "ok", to: "end" },
      ],
    );
    const { runner, item } = setup(w, { a: fake(["again", "ok"], () => ({ outcome: "again" })) });
    const run = await runner.startRun(item, w, new AbortController().signal);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("loop a:again exceeded its limit of 2");
    const stored = getWorkItem(db, item.id);
    expect(stored.status).toBe("failed");
    expect(stored.error).toBe("loop a:again exceeded its limit of 2");
    expect(listNodeRuns(db, run.id).map((r) => r.attempt)).toEqual([1, 2, 3]);
  });

  it("uses the last problem for a fail target, with a fallback", async () => {
    const w = wf(["a"], [{ from: "a", on: "bad", to: "fail" }]);
    const first = setup(w, { a: fake(["bad"], () => ({ outcome: "bad", problem: "it broke" })) });
    const run = await first.runner.startRun(first.item, w, new AbortController().signal);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("it broke");
    expect(getWorkItem(db, first.item.id)).toMatchObject({ status: "failed", error: "it broke" });

    const second = setup(w, { a: fake(["bad"], () => ({ outcome: "bad" })) });
    const run2 = await second.runner.startRun(second.item, w, new AbortController().signal);
    expect(run2.error).toBe("run failed at node a");
  });

  it("fails the run when a node throws, without rejecting", async () => {
    const w = wf(["a"], [{ from: "a", on: "ok", to: "end" }]);
    const { runner, item } = setup(w, {
      a: fake(["ok"], () => {
        throw new Error("kaboom");
      }),
    });
    const run = await runner.startRun(item, w, new AbortController().signal);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("kaboom");
    expect(getWorkItem(db, item.id)).toMatchObject({ status: "failed", error: "kaboom" });
    const rows = listNodeRuns(db, run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: null, problem: "kaboom" });
  });

  it("fails clearly on an outcome with no edge", async () => {
    const w = wf(["a"], [{ from: "a", on: "ok", to: "end" }]);
    const { runner, item } = setup(w, { a: fake(["ok"], () => ({ outcome: "weird" })) });
    const run = await runner.startRun(item, w, new AbortController().signal);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("outcome weird with no edge");
    expect(getWorkItem(db, item.id).status).toBe("failed");
  });

  it("persists current_node before the node runs", async () => {
    const w = wf(
      ["a", "b"],
      [
        { from: "a", on: "ok", to: "b" },
        { from: "b", on: "ok", to: "end" },
      ],
    );
    const seen: Record<string, string | null> = {};
    let runId = "";
    const read =
      (id: string) =>
      (ctx: NodeContext<unknown>): NodeResult => {
        void ctx;
        const row = db.prepare("SELECT id, current_node FROM runs").get() as { id: string; current_node: string };
        runId = row.id;
        seen[id] = row.current_node;
        return { outcome: "ok" };
      };
    const { runner, item } = setup(w, { a: fake(["ok"], read("a")), b: fake(["ok"], read("b")) });
    await runner.startRun(item, w, new AbortController().signal);
    expect(seen).toEqual({ a: "a", b: "b" });
    expect(runId).not.toBe("");
  });

  it("resumes a running run at current_node only, keeping edge counts", async () => {
    const w = wf(
      ["a", "b"],
      [
        { from: "a", on: "ok", to: "b" },
        { from: "b", on: "retry", to: "b", max: 2 },
        { from: "b", on: "ok", to: "end" },
      ],
    );
    const calls = { a: 0, b: 0 };
    const controller = new AbortController();
    const nodes = {
      a: fake(["ok"], () => {
        calls.a++;
        return { outcome: "ok" };
      }),
      b: fake(["retry", "ok"], () => {
        calls.b++;
        if (calls.b === 1) return { outcome: "retry" };
        if (calls.b === 2) {
          controller.abort();
          return { outcome: "retry" };
        }
        return { outcome: "ok" };
      }),
    };
    const { runner, item } = setup(w, nodes);
    const stopped = await runner.startRun(item, w, controller.signal);
    expect(stopped.status).toBe("running");
    expect(stopped.currentNode).toBe("b");
    expect(stopped.state.edgeCounts).toEqual({ "a:ok": 1, "b:retry": 1 });

    const run = await runner.resumeRun(stopped.id, new AbortController().signal);
    expect(run.status).toBe("succeeded");
    expect(calls).toEqual({ a: 1, b: 3 });
    expect(run.state.edgeCounts).toEqual({ "a:ok": 1, "b:retry": 1, "b:ok": 1 });
    // The aborted attempt wrote no row, so the resumed one is attempt 2.
    expect(
      listNodeRuns(db, run.id)
        .filter((r) => r.nodeId === "b")
        .map((r) => r.attempt),
    ).toEqual([1, 2]);
    expect(getRun(db, run.id).status).toBe("succeeded");

    expect((await runner.resumeRun(run.id, new AbortController().signal)).status).toBe("succeeded");
    expect(calls.b).toBe(3);
  });

  it("leaves the run running and the item in progress when aborted mid-node", async () => {
    const w = wf(["a"], [{ from: "a", on: "ok", to: "end" }]);
    const controller = new AbortController();
    const { runner, item } = setup(w, {
      a: fake(["ok"], () => {
        controller.abort();
        return { outcome: "ok", state: { branch: "nope" } };
      }),
    });
    const run = await runner.startRun(item, w, controller.signal);
    expect(run.status).toBe("running");
    expect(run.currentNode).toBe("a");
    expect(run.state.branch).toBeNull();
    expect(getWorkItem(db, item.id).status).toBe("in_progress");
    expect(listNodeRuns(db, run.id)).toEqual([]);
  });

  it("does not record a failure when a node throws after abort", async () => {
    const w = wf(["a"], [{ from: "a", on: "ok", to: "end" }]);
    const controller = new AbortController();
    const { runner, item } = setup(w, {
      a: fake(["ok"], () => {
        controller.abort();
        throw new Error("aborted");
      }),
    });
    const run = await runner.startRun(item, w, controller.signal);
    expect(run.status).toBe("running");
    expect(run.error).toBeNull();
    expect(getWorkItem(db, item.id).status).toBe("in_progress");
  });
});
