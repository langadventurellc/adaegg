import { spawn as nodeSpawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import {
  deleteReady,
  deleteRestartRequest,
  deleteRestartRequestIfUnchanged,
  deleteSupervisor,
  RESTART_EXIT_CODE,
  type RestartRequest,
  readReady,
  readRestartRequest,
  readSupervisor,
  writeSupervisor,
} from "../engine/lifecycle.ts";
import { currentBranch, git, isClean } from "../engine/nodes/git.ts";
import { dbPath } from "../engine/paths.ts";
import { markReverted } from "../engine/store.ts";

export type ChildHandle = {
  pid: number;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(signal: NodeJS.Signals): void;
};

export type Timing = {
  readyTimeoutMs: number;
  stableMs: number;
  crashWindowMs: number;
  maxCrashes: number;
  restartDelayMs: number;
  // How long a daemon gets to exit after SIGTERM before it is killed.
  killGraceMs: number;
  // How often readiness and uptime are checked.
  pollMs: number;
};

export const DEFAULT_TIMING: Timing = {
  readyTimeoutMs: 30_000,
  stableMs: 60_000,
  crashWindowMs: 60_000,
  maxCrashes: 3,
  restartDelayMs: 2_000,
  killGraceMs: 10_000,
  pollMs: 20,
};

type Writer = { write(text: string): unknown };

export type SupervisorDeps = {
  root: string;
  stateDir: string;
  config: Pick<Config, "setup" | "baseBranch">;
  // Starts the daemon in `cwd`; `onOutput` receives everything it prints.
  spawn?: (cwd: string, onOutput: (chunk: string) => void) => ChildHandle;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timing?: Partial<Timing>;
  stdout?: Writer;
  stderr?: Writer;
  // Where the daemon's output is echoed; defaults to stdout when it is a terminal.
  echo?: Writer | null;
  // Returns the command's exit status (null when it was killed or could not start); anything but 0 is a failure.
  // The signal is aborted when the supervisor is told to stop; the command must then be terminated.
  runSetup?: (root: string, command: string, signal: AbortSignal) => number | null | Promise<number | null>;
  // Registers a handler for SIGINT/SIGTERM and returns a function that removes it.
  signals?: (handler: () => void) => () => void;
  // Called when a daemon started after a self-change did not come up healthy; it has exited by then.
  // Defaults to reverting the merge (see `rollback`).
  onProbationFailed?: (request: RestartRequest, tail: string) => Promise<"retry" | "exit">;
  // Opens the work item database for marking the reverted item; defaults to the repo's database.
  openDb?: () => DatabaseSync;
  env?: NodeJS.ProcessEnv;
};

function defaultSpawn(cwd: string, onOutput: (chunk: string) => void): ChildHandle {
  const child = nodeSpawn("node", ["src/daemon/main.ts"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => onOutput(String(d)));
  child.stderr.on("data", (d) => onOutput(String(d)));
  return {
    pid: child.pid ?? -1,
    onExit(cb) {
      let called = false;
      const once = (code: number | null, signal: string | null) => {
        if (called) return;
        called = true;
        cb(code, signal);
      };
      child.on("error", () => once(1, null));
      child.on("close", once);
    },
    kill(signal) {
      child.kill(signal);
    },
  };
}

const SETUP_KILL_GRACE_MS = 5_000;

function defaultRunSetup(root: string, command: string, signal: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(null);
    // Its own process group, so aborting can end the shell and everything it started (npm and its children).
    const child = nodeSpawn("sh", ["-c", command], { cwd: root, stdio: "inherit", detached: true });
    const pgid = child.pid;
    const killGroup = (sig: NodeJS.Signals) => {
      if (pgid === undefined) return;
      try {
        process.kill(-pgid, sig);
      } catch {
        // already gone
      }
    };
    let grace: ReturnType<typeof setTimeout> | undefined;
    // The shell and its children (npm and its own) all get SIGTERM; the result is reported only once the shell is
    // gone, and anything still running after the grace period is killed.
    const onAbort = () => {
      killGroup("SIGTERM");
      grace = setTimeout(() => killGroup("SIGKILL"), SETUP_KILL_GRACE_MS);
      grace.unref();
    };
    child.on("error", () => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(grace);
      resolve(null);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(grace);
      if (signal.aborted) {
        // Whatever the shell left behind in the group must not outlive it.
        killGroup("SIGKILL");
        return resolve(null);
      }
      resolve(code);
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultSignals(handler: () => void): () => void {
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.removeListener("SIGINT", handler);
    process.removeListener("SIGTERM", handler);
  };
}

const MAX_BUFFER = 64 * 1024;

const describeStatus = (status: number | null): string => (status === null ? "no exit status" : `exit ${status}`);

export async function runSupervisor(deps: SupervisorDeps): Promise<number> {
  const { root, stateDir } = deps;
  const timing: Timing = { ...DEFAULT_TIMING, ...deps.timing };
  const spawn = deps.spawn ?? defaultSpawn;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const echo = deps.echo === undefined ? (process.stdout.isTTY ? process.stdout : null) : deps.echo;
  const runSetup = deps.runSetup ?? defaultRunSetup;
  const signals = deps.signals ?? defaultSignals;

  const logDir = join(stateDir, "logs");
  const logFile = join(logDir, "daemon.log");
  mkdirSync(logDir, { recursive: true });
  let buffer = "";
  const onOutput = (chunk: string) => {
    appendFileSync(logFile, chunk);
    echo?.write(chunk);
    buffer = (buffer + chunk).slice(-MAX_BUFFER);
  };
  const lastLines = (n: number): string => buffer.replace(/\n$/, "").split("\n").slice(-n).join("\n");

  const openDatabase = deps.openDb ?? (() => openDb(dbPath(root, deps.env)));

  let stopping = false;
  const stopSetup = new AbortController();

  const packagesChanged = (request: RestartRequest): boolean => {
    try {
      const files = git(root, "diff", "--name-only", request.preMergeHead, request.mergeCommit).split("\n");
      return files.some((f) => f === "package.json" || f === "package-lock.json");
    } catch {
      return true;
    }
  };

  // Reverts the merge of a restart request whose daemon did not come up healthy. Never `git reset`: the revert is a
  // new commit, so nothing but the merge's changes is undone.
  const rollback = async (held: RestartRequest, tail: string): Promise<"retry" | "exit"> => {
    // Told to stop: leave the request in place for the next start.
    if (stopping) return "retry";
    // The request on disk may have grown since the supervisor read it (a later self-change added its merge).
    let request = held;
    try {
      request = readRestartRequest(stateDir) ?? held;
    } catch {
      // keep the one this daemon was started for
    }
    stderr.write(`the new daemon did not come up healthy after merge ${request.mergeCommit}; rolling it back\n`);
    let branch: string;
    try {
      branch = currentBranch(root);
    } catch {
      branch = "(unknown)";
    }
    if (branch !== deps.config.baseBranch) {
      stderr.write(
        `the checkout ${root} is on '${branch === "HEAD" ? "a detached HEAD" : branch}', not '${deps.config.baseBranch}', ` +
          `so the merge was not reverted. Check out '${deps.config.baseBranch}', then revert ${request.mergeCommit} ` +
          `by hand (git revert -m 1 ${request.mergeCommit}). Daemon log: ${logFile}\n`,
      );
      return "exit";
    }
    if (!isClean(root)) {
      stderr.write(
        `the checkout ${root} has uncommitted changes, so the merge was not reverted:\n${git(root, "status", "--short")}\n` +
          `Commit or discard them, then revert ${request.mergeCommit} by hand (git revert -m 1 ${request.mergeCommit}). ` +
          `Daemon log: ${logFile}\n`,
      );
      return "exit";
    }
    // Delete the request before reverting, so a supervisor killed mid-rollback and restarted reverts nothing again.
    deleteRestartRequest(stateDir);
    // Newest first, so each revert applies on top of the merges that came after it.
    const merges = [{ mergeCommit: request.mergeCommit, workItemId: request.workItemId }, ...(request.earlier ?? [])];
    let order: string[] = [];
    try {
      order = git(root, "rev-list", "--first-parent", "HEAD").split("\n");
    } catch {
      // keep the request's order
    }
    const rank = (m: { mergeCommit: string }) => {
      const i = order.indexOf(m.mergeCommit);
      return i === -1 ? order.length : i;
    };
    merges.sort((a, b) => rank(a) - rank(b));
    const reverted: typeof merges = [];
    let failure: string | null = null;
    for (const merge of merges) {
      try {
        const parents = git(root, "rev-list", "--parents", "-n", "1", merge.mergeCommit).split(" ").length - 1;
        git(root, "revert", ...(parents > 1 ? ["-m", "1"] : []), "--no-edit", merge.mergeCommit);
        reverted.push(merge);
      } catch (err) {
        try {
          git(root, "revert", "--abort");
        } catch {
          // nothing to abort
        }
        failure = `reverting ${merge.mergeCommit} failed: ${err instanceof Error ? err.message : String(err)}\n`;
        break;
      }
    }
    // Record what was reverted before anything else can fail, so a done item never stays done after its merge is gone.
    for (const merge of reverted) {
      try {
        const db = openDatabase();
        try {
          markReverted(
            db,
            merge.workItemId,
            `Its merge stopped the hatchling from restarting, so it was reverted. Last daemon output: ${tail}`,
          );
        } finally {
          db.close();
        }
      } catch (err) {
        stderr.write(
          `could not mark ${merge.workItemId} as reverted: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    if (failure !== null) {
      stderr.write(failure);
      return "exit";
    }
    if (deps.config.setup !== "" && packagesChanged(request)) {
      const status = await runSetup(root, deps.config.setup, stopSetup.signal);
      if (status !== 0) {
        if (stopping) return "retry";
        stderr.write(`setup failed after the revert (${describeStatus(status)}): ${deps.config.setup}\n`);
        return "exit";
      }
    }
    stderr.write(`reverted ${request.mergeCommit}; starting the hatchling again\n`);
    return "retry";
  };

  const onProbationFailed = deps.onProbationFailed ?? rollback;

  let current: { child: ChildHandle; exited: Promise<void>; isExited: () => boolean } | null = null;

  const terminate = async (c: NonNullable<typeof current>) => {
    if (c.isExited()) return;
    c.child.kill("SIGTERM");
    // A real timer that is cleared: a pending one would keep the process alive after the daemon is gone.
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      c.exited,
      new Promise<void>((resolve) => {
        grace = setTimeout(resolve, timing.killGraceMs);
      }),
    ]);
    clearTimeout(grace);
    if (!c.isExited()) {
      c.child.kill("SIGKILL");
      await c.exited;
    }
  };

  const unsubscribe = signals(() => {
    if (stopping) return;
    stopping = true;
    stopSetup.abort();
    if (current) void terminate(current);
  });

  const crashes: number[] = [];

  try {
    writeSupervisor(stateDir, { pid: process.pid });
    while (!stopping) {
      deleteReady(stateDir);
      const request = readRestartRequest(stateDir);
      if (request && deps.config.setup !== "" && packagesChanged(request)) {
        const status = await runSetup(root, deps.config.setup, stopSetup.signal);
        if (stopping) break;
        if (status !== 0) {
          // The new code cannot start without its dependencies, so this is a failed start: roll the merge back.
          const message = `setup failed (${describeStatus(status)}): ${deps.config.setup}\n`;
          stderr.write(message);
          onOutput(message);
          const verdict = await onProbationFailed(request, lastLines(20));
          if (verdict === "exit") return 1;
          continue;
        }
      }
      if (stopping) break;

      const child = spawn(root, onOutput);
      let exitInfo: { code: number | null; signal: string | null } | null = null;
      const exited = new Promise<void>((resolve) => {
        child.onExit((code, signal) => {
          exitInfo = { code, signal };
          resolve();
        });
      });
      const c = { child, exited, isExited: () => exitInfo !== null };
      current = c;
      if (stopping) void terminate(c);

      let failed = false;
      if (request) {
        // On probation: ready in time, then up for the stable time.
        const startedAt = now();
        let readyAt: number | null = null;
        let stable = false;
        while (!c.isExited() && !stopping) {
          const t = now();
          if (readyAt === null) {
            if (readReady(stateDir)?.pid === child.pid) readyAt = t;
            else if (t - startedAt >= timing.readyTimeoutMs) {
              failed = true;
              break;
            }
          } else if (t - readyAt >= timing.stableMs) {
            // A request written since (another self-change) is not this daemon's to clear.
            deleteRestartRequestIfUnchanged(stateDir, request);
            stable = true;
            break;
          }
          await Promise.race([sleep(timing.pollMs), exited]);
        }
        // Exiting before the stable time is a failure, whatever the code.
        if (!stopping && !stable) failed = true;
      }

      if (failed) {
        await terminate(c);
        const verdict = await onProbationFailed(request as RestartRequest, lastLines(20));
        current = null;
        if (verdict === "exit") return 1;
        continue;
      }

      await exited;
      current = null;
      if (stopping) break;
      const { code } = exitInfo as unknown as { code: number | null; signal: string | null };
      if (code === 0) return 0;
      if (code === RESTART_EXIT_CODE) continue;

      const t = now();
      crashes.push(t);
      while (crashes.length > 0 && t - (crashes[0] as number) > timing.crashWindowMs) crashes.shift();
      if (readRestartRequest(stateDir) === null && crashes.length >= timing.maxCrashes) {
        stderr.write(`the hatchling won't start; see ${logFile}\n`);
        return 1;
      }
      await sleep(timing.restartDelayMs);
    }
    // Stopped by a signal; the loop only gets here once the daemon has exited.
    stdout.write("stopped\n");
    return 0;
  } finally {
    unsubscribe();
    // Never remove a record another process wrote.
    if (readSupervisor(stateDir)?.pid === process.pid) deleteSupervisor(stateDir);
  }
}
