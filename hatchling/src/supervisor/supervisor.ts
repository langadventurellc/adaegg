import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../engine/config.ts";
import {
  deleteReady,
  deleteRestartRequest,
  RESTART_EXIT_CODE,
  type RestartRequest,
  readReady,
  readRestartRequest,
} from "../engine/lifecycle.ts";
import { git } from "../engine/nodes/git.ts";

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
  config: Pick<Config, "setup">;
  // Starts the daemon in `cwd`; `onOutput` receives everything it prints.
  spawn?: (cwd: string, onOutput: (chunk: string) => void) => ChildHandle;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timing?: Partial<Timing>;
  stdout?: Writer;
  stderr?: Writer;
  // Where the daemon's output is echoed; defaults to stdout when it is a terminal.
  echo?: Writer | null;
  // Returns the command's exit status; a non-zero status stops the supervisor.
  runSetup?: (root: string, command: string) => number | null | undefined;
  // Registers a handler for SIGINT/SIGTERM and returns a function that removes it.
  signals?: (handler: () => void) => () => void;
  // Called when a daemon started after a self-change did not come up healthy; it has exited by then.
  onProbationFailed?: (request: RestartRequest, tail: string) => Promise<"retry" | "exit">;
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

function defaultRunSetup(root: string, command: string): number | null {
  return spawnSync("sh", ["-c", command], { cwd: root, stdio: "inherit" }).status;
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

  const onProbationFailed =
    deps.onProbationFailed ??
    (async (_request: RestartRequest, _tail: string) => {
      // TODO(rollback): the next task replaces this with reverting the merge and retrying.
      stderr.write("the new daemon did not come up healthy after the self-change merge\n");
      return "exit" as const;
    });

  let stopping = false;
  let current: { child: ChildHandle; exited: Promise<void>; isExited: () => boolean } | null = null;

  const terminate = async (c: NonNullable<typeof current>) => {
    if (c.isExited()) return;
    c.child.kill("SIGTERM");
    await Promise.race([c.exited, sleep(timing.killGraceMs)]);
    if (!c.isExited()) {
      c.child.kill("SIGKILL");
      await c.exited;
    }
  };

  const unsubscribe = signals(() => {
    if (stopping) return;
    stopping = true;
    if (current) void terminate(current);
  });

  const packagesChanged = (request: RestartRequest): boolean => {
    try {
      const files = git(root, "diff", "--name-only", request.preMergeHead, request.mergeCommit).split("\n");
      return files.some((f) => f === "package.json" || f === "package-lock.json");
    } catch {
      return true;
    }
  };

  const crashes: number[] = [];

  try {
    while (!stopping) {
      deleteReady(stateDir);
      const request = readRestartRequest(stateDir);
      if (request && deps.config.setup !== "" && packagesChanged(request)) {
        const status = runSetup(root, deps.config.setup);
        if (status !== undefined && status !== null && status !== 0) {
          stderr.write(`setup failed (exit ${status}): ${deps.config.setup}\n`);
          return 1;
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
            deleteRestartRequest(stateDir);
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
  }
}
