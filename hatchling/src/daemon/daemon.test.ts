import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigSchema } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import { defineNode, type NodeContext, type NodeResult } from "../engine/nodes/types.ts";
import { createRun, getRun, listRuns } from "../engine/runs.ts";
import { addWorkItem, getWorkItem } from "../engine/store.ts";
import type { Workflow } from "../engine/workflows/schema.ts";
import { createDaemon, type Daemon } from "./daemon.ts";
import { loadWorkflowsOrReport } from "./main.ts";

type Fn = (ctx: NodeContext<unknown>) => Promise<NodeResult> | NodeResult;

function fake(fn: Fn) {
  return defineNode({
    type: "fake",
    outcomes: ["ok"],
    configSchema: z.object({}).passthrough(),
    run: async (ctx: NodeContext<unknown>) => fn(ctx),
  });
}

function wf(nodes: string[], kind = "item"): Workflow {
  return {
    id: "w",
    name: "W",
    trigger: { type: "queue", kind },
    start: nodes[0] as string,
    nodes: nodes.map((id) => ({ id, type: id, config: {} })),
    edges: nodes.map((id, i) => ({ from: id, on: "ok", to: nodes[i + 1] ?? "end" })),
  };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting");
}

let db: DatabaseSync;
let daemons: Daemon[];
beforeEach(() => {
  db = openDb(":memory:");
  daemons = [];
});
afterEach(async () => {
  for (const d of daemons) await d.stop();
});

function make(workflow: Workflow, nodes: Record<string, ReturnType<typeof fake>>, maxConcurrentRuns = 1) {
  const daemon = createDaemon({
    db,
    workflows: [workflow],
    nodeTypes: nodes,
    appConfig: ConfigSchema.parse({ schema: 1, maxConcurrentRuns }),
    paths: { root: "/r", stateDir: "/r/.adaegg" },
    tickMs: 10_000,
  });
  daemons.push(daemon);
  return daemon;
}

const status = (id: string) => getWorkItem(db, id).status;

describe("daemon", () => {
  it("claims a queued item and runs it to done", async () => {
    const item = addWorkItem(db, { title: "do it" });
    const daemon = make(wf(["a"]), { a: fake(() => ({ outcome: "ok" })) });
    await daemon.tick();
    await waitFor(() => status(item.id) === "done");
    expect(listRuns(db)).toHaveLength(1);
    expect(listRuns(db)[0]?.status).toBe("succeeded");
  });

  it("honours maxConcurrentRuns", async () => {
    const first = addWorkItem(db, { title: "first" });
    const second = addWorkItem(db, { title: "second" });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const daemon = make(wf(["a"]), {
      a: fake(async () => {
        await gate;
        return { outcome: "ok" };
      }),
    });
    await daemon.tick();
    await daemon.tick();
    expect(status(first.id)).toBe("in_progress");
    expect(status(second.id)).toBe("queued");
    expect(listRuns(db)).toHaveLength(1);
    release();
    await waitFor(() => status(first.id) === "done");
    await daemon.tick();
    await waitFor(() => status(second.id) === "done");
  });

  it("writes nothing on a tick with nothing to claim", async () => {
    const other = addWorkItem(db, { title: "other kind", kind: "other" });
    const before = getWorkItem(db, other.id).updatedAt;
    const daemon = make(wf(["a"]), { a: fake(() => ({ outcome: "ok" })) });
    await daemon.tick();
    await daemon.tick();
    expect(listRuns(db)).toHaveLength(0);
    expect(getWorkItem(db, other.id).updatedAt).toBe(before);
    expect(status(other.id)).toBe("queued");
  });

  it("start resumes a running run at its current node", async () => {
    const item = addWorkItem(db, { title: "do it" });
    db.prepare("UPDATE work_items SET status = 'in_progress' WHERE id = ?").run(item.id);
    const workflow = wf(["a", "b"]);
    const run = createRun(db, getWorkItem(db, item.id), workflow);
    db.prepare("UPDATE runs SET current_node = 'b' WHERE id = ?").run(run.id);
    const seen: string[] = [];
    const daemon = make(workflow, {
      a: fake(() => {
        seen.push("a");
        return { outcome: "ok" };
      }),
      b: fake(() => {
        seen.push("b");
        return { outcome: "ok" };
      }),
    });
    await daemon.start();
    await waitFor(() => getRun(db, run.id).status === "succeeded");
    expect(seen).toEqual(["b"]);
    expect(status(item.id)).toBe("done");
  });

  it("stop mid-node leaves the run running and a new daemon finishes it", async () => {
    const item = addWorkItem(db, { title: "do it" });
    const workflow = wf(["a"]);
    let entered = false;
    const first = make(workflow, {
      a: fake(
        (ctx) =>
          new Promise<NodeResult>((_, reject) => {
            entered = true;
            ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    });
    await first.tick();
    await waitFor(() => entered);
    await first.stop();
    const [run] = listRuns(db);
    expect(run?.status).toBe("running");
    expect(run?.currentNode).toBe("a");
    expect(status(item.id)).toBe("in_progress");

    const second = make(workflow, { a: fake(() => ({ outcome: "ok" })) });
    await second.start();
    await waitFor(() => status(item.id) === "done");
    expect(getRun(db, (run as { id: string }).id).status).toBe("succeeded");
    expect(listRuns(db)).toHaveLength(1);
  });

  it("refuses to start on an invalid workflow directory, naming every problem", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "adaegg-daemon-")));
    mkdirSync(join(root, "workflows"));
    writeFileSync(join(root, "workflows", "bad.yaml"), "id: x\n");
    writeFileSync(join(root, "workflows", "worse.yaml"), "id: [\n");
    let err = "";
    const result = loadWorkflowsOrReport(root, {
      write: (t) => {
        err += t;
      },
    });
    expect(result).toBeNull();
    expect(err).toContain("invalid workflows:");
    expect(err).toContain("bad.yaml");
    expect(err).toContain("worse.yaml");
  });
});
