import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { type Config, loadConfig } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import { deleteReady, RESTART_EXIT_CODE, writeReady } from "../engine/lifecycle.ts";
import { git } from "../engine/nodes/git.ts";
import { builtinNodeTypes } from "../engine/nodes/index.ts";
import type { NodeRegistry } from "../engine/nodes/types.ts";
import { dbPath, findRepoRoot, stateDir } from "../engine/paths.ts";
import { loadWorkflows } from "../engine/workflows/load.ts";
import type { Workflow } from "../engine/workflows/schema.ts";
import { createDaemon, type Daemon } from "./daemon.ts";

// Loads the workflows, or writes the loader's message to stderr and returns null so the daemon refuses to start.
export function loadWorkflowsOrReport(
  root: string,
  stderr: { write(text: string): unknown },
  nodeTypes = builtinNodeTypes,
): Workflow[] | null {
  try {
    return loadWorkflows(join(root, "workflows"), nodeTypes);
  } catch (err) {
    stderr.write(`daemon: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

export type StartDeps = {
  db: DatabaseSync;
  workflows: Workflow[];
  nodeTypes: NodeRegistry;
  appConfig: Config;
  paths: { root: string; stateDir: string };
  tickMs?: number;
  exit: (code: number) => void;
};

export type Started = { daemon: Daemon; shutdown: () => Promise<void> };

// Starts the daemon, runs the first tick, then publishes ready.json. A clean stop (`shutdown`) or a restart
// request removes ready.json, closes the db and calls `exit`.
export async function startDaemon(deps: StartDeps): Promise<Started> {
  const { db, paths, exit } = deps;
  let finished = false;
  const finish = async (code: number) => {
    finished = true;
    await daemon.stop();
    db.close();
    deleteReady(paths.stateDir);
    exit(code);
  };
  const daemon = createDaemon({
    db,
    workflows: deps.workflows,
    nodeTypes: deps.nodeTypes,
    appConfig: deps.appConfig,
    paths,
    ...(deps.tickMs === undefined ? {} : { tickMs: deps.tickMs }),
    onRestart: () => {
      void finish(RESTART_EXIT_CODE);
    },
  });
  const startedAt = new Date().toISOString();
  await daemon.start();
  await daemon.tick();
  // A restart requested during startup has already removed ready.json; don't publish a daemon that is exiting.
  if (!finished) {
    writeReady(paths.stateDir, { pid: process.pid, startedAt, head: git(paths.root, "rev-parse", "HEAD") });
  }
  return { daemon, shutdown: () => finish(0) };
}

export async function main(): Promise<void> {
  const root = findRepoRoot(process.cwd());
  const appConfig = loadConfig(root);
  const workflows = loadWorkflowsOrReport(root, process.stderr);
  if (!workflows) {
    process.exitCode = 1;
    return;
  }
  const db = openDb(dbPath(root, process.env));
  const { shutdown } = await startDaemon({
    db,
    workflows,
    nodeTypes: builtinNodeTypes,
    appConfig,
    paths: { root, stateDir: stateDir(root, process.env) },
    exit: (code) => process.exit(code),
  });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  await main();
}
