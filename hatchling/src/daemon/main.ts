import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import { builtinNodeTypes } from "../engine/nodes/index.ts";
import { dbPath, findRepoRoot, stateDir } from "../engine/paths.ts";
import { loadWorkflows } from "../engine/workflows/load.ts";
import type { Workflow } from "../engine/workflows/schema.ts";
import { createDaemon } from "./daemon.ts";

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

export async function main(): Promise<void> {
  const root = findRepoRoot(process.cwd());
  const appConfig = loadConfig(root);
  const workflows = loadWorkflowsOrReport(root, process.stderr);
  if (!workflows) {
    process.exitCode = 1;
    return;
  }
  const db = openDb(dbPath(root, process.env));
  const daemon = createDaemon({
    db,
    workflows,
    nodeTypes: builtinNodeTypes,
    appConfig,
    paths: { root, stateDir: stateDir(root, process.env) },
  });
  const shutdown = () => {
    void daemon.stop().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await daemon.start();
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  await main();
}
