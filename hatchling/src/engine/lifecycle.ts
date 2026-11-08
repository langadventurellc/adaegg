import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// Exit code the daemon uses to ask its supervisor for a restart.
export const RESTART_EXIT_CODE = 75;

const MergeRefSchema = z.object({ mergeCommit: z.string(), workItemId: z.string() });
export type MergeRef = z.infer<typeof MergeRefSchema>;

// `mergeCommit` is the newest self-changing merge and `preMergeHead` the first parent of the oldest; `earlier` holds
// the other merges that one restart covers, so a rollback reverts all of them.
export const RestartRequestSchema = z.object({
  mergeCommit: z.string(),
  workItemId: z.string(),
  preMergeHead: z.string(),
  requestedAt: z.string().datetime(),
  earlier: z.array(MergeRefSchema).optional(),
});
export type RestartRequest = z.infer<typeof RestartRequestSchema>;

export const ReadySchema = z.object({
  pid: z.number().int(),
  startedAt: z.string(),
  head: z.string(),
});
export type Ready = z.infer<typeof ReadySchema>;

export const restartPath = (stateDir: string): string => join(stateDir, "restart.json");
export const readyPath = (stateDir: string): string => join(stateDir, "ready.json");

function writeJsonAtomic(stateDir: string, path: string, value: unknown): void {
  mkdirSync(stateDir, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function writeRestartRequest(stateDir: string, request: RestartRequest): void {
  writeJsonAtomic(stateDir, restartPath(stateDir), RestartRequestSchema.parse(request));
}

export function readRestartRequest(stateDir: string): RestartRequest | null {
  const path = restartPath(stateDir);
  const text = readText(path);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = RestartRequestSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${path} is not a valid restart request: ${parsed.error.message}`);
  return parsed.data;
}

export function deleteRestartRequest(stateDir: string): void {
  rmSync(restartPath(stateDir), { force: true });
}

// Deletes the request only if it is still `request`: a newer one written meanwhile must survive.
export function deleteRestartRequestIfUnchanged(stateDir: string, request: RestartRequest): boolean {
  let current: RestartRequest | null;
  try {
    current = readRestartRequest(stateDir);
  } catch {
    return false;
  }
  if (current === null) return true;
  if (JSON.stringify(current) !== JSON.stringify(request)) return false;
  deleteRestartRequest(stateDir);
  return true;
}

export function writeReady(stateDir: string, ready: Ready): void {
  writeJsonAtomic(stateDir, readyPath(stateDir), ReadySchema.parse(ready));
}

export function readReady(stateDir: string): Ready | null {
  try {
    const text = readText(readyPath(stateDir));
    if (text === null) return null;
    const parsed = ReadySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function deleteReady(stateDir: string): void {
  rmSync(readyPath(stateDir), { force: true });
}

const RESTART_PREFIXES = ["src/", "workflows/", "prompts/", "bin/"];
const RESTART_FILES = ["package.json", "package-lock.json", "adaegg.json"];

// True when a merge changed code or config the running daemon was loaded from.
export function touchesRestartPaths(changedPaths: string[]): boolean {
  return changedPaths.some((p) => RESTART_FILES.includes(p) || RESTART_PREFIXES.some((prefix) => p.startsWith(prefix)));
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
