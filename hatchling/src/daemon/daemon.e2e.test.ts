import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigSchema } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import { builtinNodeTypes } from "../engine/nodes/index.ts";
import { buildTemplateRepo, copyRepo, removeAllRepos, removeCopies, sh } from "../engine/nodes/test-repo.ts";
import { defineNode, type NodeContext, type NodeRegistry, type NodeResult } from "../engine/nodes/types.ts";
import { getRun, listNodeRuns, listRuns } from "../engine/runs.ts";
import { addWorkItem, getWorkItem } from "../engine/store.ts";
import { loadWorkflows } from "../engine/workflows/load.ts";
import { createDaemon, type Daemon } from "./daemon.ts";

const WORKFLOW = `id: fixture
name: Fixture
trigger: { type: queue, kind: item }
start: branch
nodes:
  - { id: branch, type: branch }
  - { id: commit-file, type: commit-file }
  - { id: checks, type: checks }
  - { id: merge, type: merge }
edges:
  - { from: branch, on: ok, to: commit-file }
  - { from: branch, on: fail, to: fail }
  - { from: commit-file, on: ok, to: checks }
  - { from: checks, on: passed, to: merge }
  - { from: checks, on: failed, to: fail }
  - { from: merge, on: merged, to: end }
  - { from: merge, on: moved, to: checks, max: 3 }
  - { from: merge, on: conflict, to: fail }
  - { from: merge, on: blocked, to: fail }
`;

let template: string;
beforeAll(() => {
  template = buildTemplateRepo();
  mkdirSync(join(template, "workflows"));
  writeFileSync(join(template, "workflows", "fixture.yaml"), WORKFLOW);
  sh(template, "add", "-A");
  sh(template, "commit", "-m", "add workflows");
});

// Commits feature.txt in the worktree; safe to run twice.
async function commitFile(ctx: NodeContext<unknown>): Promise<NodeResult> {
  const dir = ctx.state.worktree as string;
  if (!existsSync(join(dir, "feature.txt"))) {
    writeFileSync(join(dir, "feature.txt"), "feature\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-m", "add feature");
  }
  return { outcome: "ok" };
}

function registry(run: (ctx: NodeContext<unknown>) => Promise<NodeResult>): NodeRegistry {
  return {
    ...builtinNodeTypes,
    "commit-file": defineNode({
      type: "commit-file",
      outcomes: ["ok"],
      configSchema: z.object({}).passthrough(),
      run,
    }),
  };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting");
}

let root: string;
let db: DatabaseSync;
let daemons: Daemon[];
beforeEach(() => {
  root = copyRepo(template);
  db = openDb(":memory:");
  daemons = [];
});
afterEach(async () => {
  for (const d of daemons) await d.stop();
  db.close();
  removeCopies();
});
afterAll(removeAllRepos);

function makeDaemon(nodeTypes: NodeRegistry, setup = ""): Daemon {
  const daemon = createDaemon({
    db,
    workflows: loadWorkflows(join(root, "workflows"), nodeTypes),
    nodeTypes,
    appConfig: ConfigSchema.parse({ schema: 1, setup, checks: "true" }),
    paths: { root, stateDir: join(root, ".adaegg") },
    tickMs: 10_000,
  });
  daemons.push(daemon);
  return daemon;
}

describe("daemon end to end", () => {
  it("runs a claimed item through branch, checks and merge onto main", async () => {
    const item = addWorkItem(db, { title: "Add the feature" });
    const daemon = makeDaemon(registry(commitFile));
    await daemon.tick();
    await waitFor(() => getWorkItem(db, item.id).status !== "in_progress");

    expect(getWorkItem(db, item.id).status).toBe("done");
    expect(readFileSync(join(root, "feature.txt"), "utf8")).toBe("feature\n");
    expect(sh(root, "log", "-1", "--format=%s")).toBe(`hatch: Add the feature (${item.id.slice(0, 8)})`);
    const [run] = listRuns(db);
    expect(run?.status).toBe("succeeded");
    expect(run?.state.mergeCommit).toBe(sh(root, "rev-parse", "HEAD"));
    expect(listNodeRuns(db, (run as { id: string }).id).map((n) => [n.nodeId, n.outcome])).toEqual([
      ["branch", "ok"],
      ["commit-file", "ok"],
      ["checks", "passed"],
      ["merge", "merged"],
    ]);
  });

  it("stops promptly during a long setup and leaves the run to resume", async () => {
    const item = addWorkItem(db, { title: "Add the feature" });
    const daemon = makeDaemon(registry(commitFile), "touch setup-started; sleep 30");
    await daemon.tick();
    await waitFor(() => existsSync(join(root, ".adaegg", "worktrees", item.id.slice(0, 8), "setup-started")));
    const started = Date.now();
    await daemon.stop();
    expect(Date.now() - started).toBeLessThan(5000);
    const [run] = listRuns(db);
    expect(run?.status).toBe("running");
    expect(run?.currentNode).toBe("branch");
    expect(getWorkItem(db, item.id).status).toBe("in_progress");
  });

  it("resumes after a restart in the middle of a run and merges", async () => {
    const item = addWorkItem(db, { title: "Add the feature" });
    let entered = false;
    const first = makeDaemon(
      registry(
        (ctx) =>
          new Promise<NodeResult>((_, reject) => {
            entered = true;
            ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    await first.tick();
    await waitFor(() => entered);
    await first.stop();
    const [interrupted] = listRuns(db);
    expect(interrupted?.status).toBe("running");
    expect(interrupted?.currentNode).toBe("commit-file");
    expect(existsSync(join(root, "feature.txt"))).toBe(false);

    const second = makeDaemon(registry(commitFile));
    await second.start();
    await waitFor(() => getWorkItem(db, item.id).status !== "in_progress");

    expect(getWorkItem(db, item.id).status).toBe("done");
    expect(getRun(db, (interrupted as { id: string }).id).status).toBe("succeeded");
    expect(listRuns(db)).toHaveLength(1);
    expect(readFileSync(join(root, "feature.txt"), "utf8")).toBe("feature\n");
  });
});
