import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { failInterruptedTurns } from "../engine/chat.ts";
import { type Config, loadConfig } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import { deleteReady, RESTART_EXIT_CODE, writeReady } from "../engine/lifecycle.ts";
import { git } from "../engine/nodes/git.ts";
import { builtinNodeTypes } from "../engine/nodes/index.ts";
import type { NodeRegistry } from "../engine/nodes/types.ts";
import { dbPath, findRepoRoot, stateDir } from "../engine/paths.ts";
import { loadWorkflows } from "../engine/workflows/load.ts";
import type { Workflow } from "../engine/workflows/schema.ts";
import { type ChatRunner, createChatRunner } from "../server/chat.ts";
import { createUiServer } from "../server/server.ts";
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
  ui?: { start(): Promise<{ url: string }>; stop(): Promise<void> };
  exit: (code: number) => void;
};

export type Started = { daemon: Daemon; shutdown: () => Promise<void> };

// Starts the daemon, runs the first tick, then publishes ready.json. A clean stop (`shutdown`) or a restart
// request removes ready.json, closes the db and calls `exit`.
export async function startDaemon(deps: StartDeps): Promise<Started> {
  const { db, paths, exit, ui } = deps;
  let finished = false;
  const stopUi = async () => {
    try {
      await ui?.stop();
    } catch (err) {
      process.stderr.write(`daemon: UI failed to stop: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };
  const finish = async (code: number) => {
    finished = true;
    await daemon.stop();
    await stopUi();
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
  let url: string | undefined;
  if (!finished && ui) {
    try {
      url = (await ui.start()).url;
      process.stdout.write(`hatchling UI: ${url}\n`);
    } catch (err) {
      // A broken UI must not stop the engine.
      process.stderr.write(`daemon: UI failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    // A restart requested while the UI was starting could not stop it (it was not up yet); stop it now.
    if (finished && url !== undefined) await stopUi();
  }
  if (!finished) {
    writeReady(paths.stateDir, {
      pid: process.pid,
      startedAt,
      head: git(paths.root, "rev-parse", "HEAD"),
      ...(url === undefined ? {} : { url }),
    });
  }
  return { daemon, shutdown: () => finish(0) };
}

// The real UI server, adapted to what `startDaemon` needs.
function uiFor(db: DatabaseSync, root: string, port: number, chat: ChatRunner): NonNullable<StartDeps["ui"]> {
  const server = createUiServer({ db, root, port, chat });
  return { start: async () => ({ url: (await server.start()).url }), stop: () => server.stop() };
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
  // Only the daemon owns chat turns, so only it can know that a pending one was cut off by a restart.
  failInterruptedTurns(db);
  const chat = createChatRunner({ db, root, stateDir: stateDir(root, process.env), appConfig, query });
  const { shutdown } = await startDaemon({
    db,
    workflows,
    nodeTypes: builtinNodeTypes,
    appConfig,
    paths: { root, stateDir: stateDir(root, process.env) },
    ...(appConfig.ui.enabled ? { ui: uiFor(db, root, appConfig.ui.port, chat) } : {}),
    exit: (code) => process.exit(code),
  });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  await main();
}
