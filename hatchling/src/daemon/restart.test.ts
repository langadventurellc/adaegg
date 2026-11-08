import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigSchema } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import { readReady, readRestartRequest, restartPath } from "../engine/lifecycle.ts";
import { buildTemplateRepo, copyRepo, removeAllRepos, removeCopies, sh } from "../engine/nodes/test-repo.ts";
import { defineNode, type NodeContext, type NodeResult } from "../engine/nodes/types.ts";
import { addWorkItem, getWorkItem } from "../engine/store.ts";
import type { Workflow } from "../engine/workflows/schema.ts";
import type { Daemon } from "./daemon.ts";
import { startDaemon } from "./main.ts";

function wf(): Workflow {
  return {
    id: "w",
    name: "W",
    trigger: { type: "queue", kind: "item" },
    start: "a",
    nodes: [{ id: "a", type: "a", config: {} }],
    edges: [{ from: "a", on: "ok", to: "end" }],
  };
}

// Merges a branch that adds `file` into main with --no-ff, as the merge node does.
function mergeFile(root: string, file: string, title: string): { mergeCommit: string; changedPaths: string[] } {
  const branch = `b-${title}`;
  sh(root, "checkout", "-b", branch);
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), `${title}\n`);
  sh(root, "add", "-A");
  sh(root, "commit", "-m", title);
  sh(root, "checkout", "main");
  sh(root, "merge", "--no-ff", "-m", `merge ${title}`, branch);
  return { mergeCommit: sh(root, "rev-parse", "HEAD"), changedPaths: [file] };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting");
}

let template: string;
beforeAll(() => {
  template = buildTemplateRepo();
});

let root: string;
let stateDir: string;
let db: DatabaseSync;
let daemons: Daemon[];
beforeEach(() => {
  root = copyRepo(template);
  stateDir = mkdtempSync(join(tmpdir(), "adaegg-state-"));
  db = openDb(":memory:");
  daemons = [];
});
afterEach(async () => {
  for (const d of daemons) await d.stop();
  if (db.isOpen) db.close(); // a restart or shutdown closes it already
  rmSync(stateDir, { recursive: true, force: true });
  removeCopies();
});
afterAll(removeAllRepos);

function start(
  nodeRun: (ctx: NodeContext<unknown>) => Promise<NodeResult>,
  opts: { maxConcurrentRuns?: number; exit?: (code: number) => void } = {},
) {
  const restarts: number[] = [];
  const node = defineNode({
    type: "a",
    outcomes: ["ok"],
    configSchema: z.object({}).passthrough(),
    run: nodeRun,
  });
  return startDaemon({
    db,
    workflows: [wf()],
    nodeTypes: { a: node },
    appConfig: ConfigSchema.parse({ schema: 1, maxConcurrentRuns: opts.maxConcurrentRuns ?? 1 }),
    paths: { root, stateDir },
    tickMs: 10_000,
    exit: (code) => {
      restarts.push(code);
      opts.exit?.(code);
    },
  }).then((started) => {
    daemons.push(started.daemon);
    return { ...started, exits: restarts };
  });
}

describe("restart request", () => {
  it("writes restart.json and exits 75 for a merge touching src/", async () => {
    const item = addWorkItem(db, { title: "code" });
    const { exits } = await start(async () => ({ outcome: "ok", state: mergeFile(root, "src/x.ts", "code") }));
    await waitFor(() => exits.length > 0);
    expect(exits).toEqual([75]);
    const request = readRestartRequest(stateDir);
    expect(request).toMatchObject({
      mergeCommit: sh(root, "rev-parse", "HEAD"),
      workItemId: item.id,
      preMergeHead: sh(root, "rev-parse", "HEAD^1"),
    });
    expect(existsSync(join(stateDir, "ready.json"))).toBe(false);
  });

  it("writes nothing and does not exit for a merge touching only docs/", async () => {
    const item = addWorkItem(db, { title: "docs" });
    const { exits } = await start(async () => ({ outcome: "ok", state: mergeFile(root, "docs/x.md", "docs") }));
    await waitFor(() => getWorkItem(db, item.id).status === "done");
    await new Promise((r) => setTimeout(r, 50));
    expect(exits).toEqual([]);
    expect(existsSync(restartPath(stateDir))).toBe(false);
  });

  it("waits for another in-flight run and claims nothing meanwhile", async () => {
    const fast = addWorkItem(db, { title: "fast" });
    const slow = addWorkItem(db, { title: "slow" });
    const later = addWorkItem(db, { title: "later" });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const events: string[] = [];
    const { daemon, exits } = await start(
      async (ctx) => {
        if (ctx.workItem.id === slow.id) {
          await gate;
          events.push("slow finished");
          return { outcome: "ok" };
        }
        return { outcome: "ok", state: mergeFile(root, "src/x.ts", "fast") };
      },
      { maxConcurrentRuns: 2, exit: () => events.push("exit") },
    );
    await waitFor(() => getWorkItem(db, fast.id).status === "done");
    await waitFor(() => existsSync(restartPath(stateDir)));
    await daemon.tick();
    expect(getWorkItem(db, later.id).status).toBe("queued");
    expect(getWorkItem(db, slow.id).status).toBe("in_progress");
    expect(exits).toEqual([]);
    release();
    await waitFor(() => exits.length > 0);
    expect(events).toEqual(["slow finished", "exit"]);
    expect(exits).toEqual([75]);
  });

  it("claims nothing while restart.json exists, as the supervisor is still judging a self-change", async () => {
    const item = addWorkItem(db, { title: "waits" });
    writeFileSync(
      restartPath(stateDir),
      JSON.stringify({
        mergeCommit: "a".repeat(40),
        workItemId: "x",
        preMergeHead: "b".repeat(40),
        requestedAt: new Date().toISOString(),
      }),
    );
    const { daemon, exits } = await start(async () => ({ outcome: "ok" }));
    await daemon.tick();
    expect(getWorkItem(db, item.id).status).toBe("queued");
    expect(exits).toEqual([]);
  });

  it("covers every self-changing merge that finishes while draining in one request", async () => {
    const first = addWorkItem(db, { title: "first" });
    const second = addWorkItem(db, { title: "second" });
    const slow = addWorkItem(db, { title: "slow" });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const merges: Record<string, string> = {};
    const { exits } = await start(
      async (ctx) => {
        if (ctx.workItem.id === slow.id) {
          await gate;
          return { outcome: "ok" };
        }
        const state = mergeFile(root, `src/${ctx.workItem.title}.ts`, ctx.workItem.title);
        merges[ctx.workItem.id] = state.mergeCommit;
        return { outcome: "ok", state };
      },
      { maxConcurrentRuns: 3 },
    );
    await waitFor(() => getWorkItem(db, first.id).status === "done" && getWorkItem(db, second.id).status === "done");
    expect(exits).toEqual([]);
    release();
    await waitFor(() => exits.length > 0);
    const request = readRestartRequest(stateDir);
    expect(request?.mergeCommit).toBe(sh(root, "rev-parse", "HEAD"));
    expect(request?.preMergeHead).toBe(sh(root, "rev-parse", `${merges[first.id]}^1`));
    const covered = [request?.mergeCommit, ...(request?.earlier ?? []).map((m) => m.mergeCommit)].sort();
    expect(covered).toEqual([merges[first.id], merges[second.id]].sort());
    expect(request?.workItemId).toBe(second.id);
    expect(request?.earlier).toEqual([{ mergeCommit: merges[first.id], workItemId: first.id }]);
  });

  it("requests no restart when rev-parse fails", async () => {
    addWorkItem(db, { title: "bad" });
    const { exits } = await start(async () => ({
      outcome: "ok",
      state: { mergeCommit: "0".repeat(40), changedPaths: ["src/x.ts"] },
    }));
    await new Promise((r) => setTimeout(r, 100));
    expect(exits).toEqual([]);
    expect(existsSync(restartPath(stateDir))).toBe(false);
  });
});

describe("ready.json", () => {
  it("is written after the first tick and deleted on clean stop", async () => {
    const item = addWorkItem(db, { title: "first" });
    const { shutdown, exits } = await start(async () => ({ outcome: "ok" }));
    // startDaemon returns once ready.json is written, so the first tick had already claimed the item.
    expect(getWorkItem(db, item.id).status).not.toBe("queued");
    expect(readReady(stateDir)).toMatchObject({ pid: process.pid, head: sh(root, "rev-parse", "HEAD") });
    await shutdown();
    expect(existsSync(join(stateDir, "ready.json"))).toBe(false);
    expect(exits).toEqual([0]);
  });
});
