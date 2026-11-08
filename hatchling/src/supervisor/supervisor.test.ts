import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isPidAlive, restartPath, writeRestartRequest } from "../engine/lifecycle.ts";
import { buildTemplateRepo, copyRepo, removeAllRepos, removeCopies, sh } from "../engine/nodes/test-repo.ts";
import { type ChildHandle, runSupervisor, type SupervisorDeps } from "./supervisor.ts";

// The fake daemon: `node daemon.mjs <stateDir> <behavior>`. Behaviors: `healthy` (publishes ready.json, stays up),
// `never-ready` (stays up silently) and `exit:<code>`. On SIGTERM it prints a line and exits 0.
const DAEMON = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const [stateDir, behavior] = process.argv.slice(2);
console.log("daemon " + process.pid + " " + behavior);
process.on("SIGTERM", () => { console.log("got SIGTERM"); process.exit(0); });
if (behavior.startsWith("exit:")) {
  console.error("boom");
  process.exit(Number(behavior.slice(5)));
}
if (behavior === "healthy") {
  writeFileSync(join(stateDir, "ready.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), head: "x" }));
}
setInterval(() => {}, 1000);
`;

let template: string;
let scriptDir: string;
let script: string;
let repo: string;
let stateDir: string;

beforeAll(() => {
  template = buildTemplateRepo();
  scriptDir = realpathSync(mkdtempSync(join(tmpdir(), "adaegg-daemon-")));
  script = join(scriptDir, "daemon.mjs");
  writeFileSync(script, DAEMON);
});

afterAll(() => {
  rmSync(scriptDir, { recursive: true, force: true });
  removeAllRepos();
});

beforeEach(() => {
  repo = copyRepo(template);
  stateDir = join(repo, ".adaegg");
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  removeCopies();
});

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleepReal(5);
  }
}

// Two real commits: the second touches package.json, or only a doc.
function makeRequest(touchPackage: boolean) {
  const preMergeHead = sh(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, touchPackage ? "package.json" : "notes.md"), "{}\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-m", "merge");
  return {
    mergeCommit: sh(repo, "rev-parse", "HEAD"),
    workItemId: "item-1",
    preMergeHead,
    requestedAt: new Date().toISOString(),
  };
}

function writeRequest(touchPackage = false) {
  const request = makeRequest(touchPackage);
  writeRestartRequest(stateDir, request);
  return request;
}

type Harness = {
  deps: SupervisorDeps;
  spawned: ChildHandle[];
  sleeps: number[];
  stderr: () => string;
  signal: () => void;
};

// `behaviors[i]` is what the i-th daemon start does; `exit:75` also writes a restart request first.
function harness(behaviors: string[], over: Partial<SupervisorDeps> = {}): Harness {
  const spawned: ChildHandle[] = [];
  const sleeps: number[] = [];
  let err = "";
  let handler: (() => void) | null = null;
  const deps: SupervisorDeps = {
    root: repo,
    stateDir,
    config: { setup: "" },
    echo: null,
    stdout: { write: () => true },
    stderr: {
      write: (t) => {
        err += t;
      },
    },
    timing: {
      readyTimeoutMs: 5000,
      stableMs: 60,
      crashWindowMs: 60_000,
      maxCrashes: 3,
      restartDelayMs: 5,
      killGraceMs: 1000,
      pollMs: 5,
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return sleepReal(ms);
    },
    signals: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    spawn: (cwd, onOutput) => {
      const behavior = behaviors[spawned.length] ?? "healthy";
      if (behavior === "exit:75") writeRequest();
      const child = nodeSpawn("node", [script, stateDir, behavior], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => onOutput(String(d)));
      child.stderr.on("data", (d) => onOutput(String(d)));
      const handle: ChildHandle = {
        pid: child.pid as number,
        onExit: (cb) => child.on("close", cb),
        kill: (s) => child.kill(s),
      };
      spawned.push(handle);
      return handle;
    },
    ...over,
  };
  return { deps, spawned, sleeps, stderr: () => err, signal: () => handler?.() };
}

describe("runSupervisor", () => {
  it("returns 0 when the daemon exits 0", async () => {
    const h = harness(["exit:0"]);
    expect(await runSupervisor(h.deps)).toBe(0);
    expect(h.spawned).toHaveLength(1);
  });

  it("restarts at once on exit 75, deletes restart.json once the new daemon is stable, and keeps running", async () => {
    const h = harness(["exit:75", "healthy"], { timing: { restartDelayMs: 7, stableMs: 60, pollMs: 5 } });
    const done = runSupervisor(h.deps);
    await waitFor(() => h.spawned.length === 2, "the second start");
    expect(existsSync(restartPath(stateDir))).toBe(true);
    await waitFor(() => !existsSync(restartPath(stateDir)), "restart.json to be deleted");
    expect(h.spawned).toHaveLength(2);
    expect(h.sleeps).not.toContain(7); // no restart delay after 75
    h.signal();
    expect(await done).toBe(0);
  });

  it("returns 1 with a message after three crashes in a row with no restart request", async () => {
    const h = harness(["exit:1", "exit:2", "exit:1", "exit:1"]);
    expect(await runSupervisor(h.deps)).toBe(1);
    expect(h.spawned).toHaveLength(3);
    expect(h.stderr()).toBe(`the hatchling won't start; see ${join(stateDir, "logs", "daemon.log")}\n`);
    expect(readFileSync(join(stateDir, "logs", "daemon.log"), "utf8")).toContain("boom");
  });

  it("does not count crashes that fall outside the window", async () => {
    let t = 0;
    const h = harness(["exit:1", "exit:1", "exit:1", "exit:1", "exit:0"], {
      now: () => {
        t += 40_000;
        return t;
      },
    });
    expect(await runSupervisor(h.deps)).toBe(0);
    expect(h.spawned).toHaveLength(5);
  });

  it("restarts after the delay when the daemon crashes", async () => {
    const h = harness(["exit:1", "exit:0"], { timing: { restartDelayMs: 7, pollMs: 5 } });
    expect(await runSupervisor(h.deps)).toBe(0);
    expect(h.spawned).toHaveLength(2);
    expect(h.sleeps).toContain(7);
  });

  it.each([
    [true, 1],
    [false, 0],
  ])("runs setup only when package files changed (package changed: %s)", async (touchPackage, calls) => {
    const request = writeRequest(touchPackage);
    const setupCalls: [string, string][] = [];
    const h = harness(["healthy"], {
      config: { setup: "npm ci" },
      runSetup: (root, command) => {
        setupCalls.push([root, command]);
      },
    });
    const done = runSupervisor(h.deps);
    await waitFor(() => !existsSync(restartPath(stateDir)), "restart.json to be deleted");
    h.signal();
    expect(await done).toBe(0);
    expect(setupCalls).toHaveLength(calls);
    if (calls > 0) expect(setupCalls[0]).toEqual([repo, "npm ci"]);
    expect(request.preMergeHead).not.toBe(request.mergeCommit);
  });

  it("skips setup when the command is empty", async () => {
    writeRequest(true);
    const setupCalls: string[] = [];
    const h = harness(["healthy"], {
      runSetup: (_r, c) => {
        setupCalls.push(c);
      },
    });
    const done = runSupervisor(h.deps);
    await waitFor(() => !existsSync(restartPath(stateDir)), "restart.json to be deleted");
    h.signal();
    await done;
    expect(setupCalls).toEqual([]);
  });

  it("kills a daemon that never becomes ready and calls onProbationFailed", async () => {
    const request = writeRequest();
    const calls: { request: unknown; tail: string }[] = [];
    const h = harness(["never-ready"], {
      timing: { readyTimeoutMs: 150, stableMs: 60, restartDelayMs: 5, killGraceMs: 1000, pollMs: 5 },
      onProbationFailed: async (r, tail) => {
        calls.push({ request: r, tail });
        return "exit";
      },
    });
    expect(await runSupervisor(h.deps)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toEqual(request);
    expect(calls[0]?.tail).toContain("never-ready");
    expect(isPidAlive((h.spawned[0] as ChildHandle).pid)).toBe(false);
  });

  it("calls onProbationFailed when a daemon on probation exits", async () => {
    writeRequest();
    let called = 0;
    const h = harness(["exit:1"], {
      onProbationFailed: async (_r, tail) => {
        called++;
        expect(tail).toContain("boom");
        return "exit";
      },
    });
    expect(await runSupervisor(h.deps)).toBe(1);
    expect(called).toBe(1);
    expect(h.spawned).toHaveLength(1);
  });

  it("by default reports an unhealthy new daemon and returns 1", async () => {
    writeRequest();
    const h = harness(["exit:1"]);
    expect(await runSupervisor(h.deps)).toBe(1);
    expect(h.stderr()).toContain("did not come up healthy");
  });

  it("starts again when onProbationFailed answers retry", async () => {
    writeRequest();
    const h = harness(["exit:1", "exit:0"], {
      onProbationFailed: async () => {
        rmSync(restartPath(stateDir), { force: true });
        return "retry";
      },
    });
    expect(await runSupervisor(h.deps)).toBe(0);
    expect(h.spawned).toHaveLength(2);
  });

  it("forwards SIGTERM to the daemon and returns 0 without restarting", async () => {
    const h = harness(["healthy"]);
    const done = runSupervisor(h.deps);
    await waitFor(() => existsSync(join(stateDir, "ready.json")), "ready.json");
    h.signal();
    expect(await done).toBe(0);
    expect(h.spawned).toHaveLength(1);
    expect(readFileSync(join(stateDir, "logs", "daemon.log"), "utf8")).toContain("got SIGTERM");
  });
});
