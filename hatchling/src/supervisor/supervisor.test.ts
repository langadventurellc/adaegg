import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../engine/db.ts";
import { isPidAlive, type RestartRequest, restartPath, writeRestartRequest } from "../engine/lifecycle.ts";
import { buildTemplateRepo, copyRepo, removeAllRepos, removeCopies, sh } from "../engine/nodes/test-repo.ts";
import { addWorkItem, claimNext, finishWorkItem, getWorkItem } from "../engine/store.ts";
import { type ChildHandle, runSupervisor, type SupervisorDeps } from "./supervisor.ts";

// The fake daemon: `node daemon.mjs <stateDir> <behavior>`. Behaviors: `healthy` (publishes ready.json, stays up),
// `never-ready` (stays up silently) and `exit:<code>`. On SIGTERM it prints a line and exits 0.
const DAEMON = `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [stateDir, behavior] = process.argv.slice(2);
console.log("daemon " + process.pid + " " + behavior);
process.on("SIGTERM", () => { console.log("got SIGTERM"); process.exit(0); });
if (behavior.startsWith("exit:")) {
  console.error("boom");
  process.exit(Number(behavior.slice(5)));
}
if (behavior === "by-repo") {
  // Behaves by the checked-out code: mode.txt starting with "broken" crashes, "silent" never becomes ready.
  const mode = readFileSync(join(process.cwd(), "mode.txt"), "utf8").trim();
  if (mode.startsWith("broken")) {
    console.error("boom " + mode);
    process.exit(1);
  }
  if (mode !== "silent") {
    writeFileSync(join(stateDir, "ready.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), head: "x" }));
  }
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
let dbFile: string;
let itemId: string;
// The restart request a "exit:75" start writes; a plain one when null.
let mergeRequest: RestartRequest | null;

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
  mergeRequest = null;
  dbFile = join(stateDir, "hatch.db");
  const db = openDb(dbFile);
  itemId = addWorkItem(db, { title: "self change" }).id;
  claimNext(db, "item");
  finishWorkItem(db, itemId);
  db.close();
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

const itemStatus = () => {
  const db = openDb(dbFile);
  try {
    return getWorkItem(db, itemId);
  } finally {
    db.close();
  }
};

// A real --no-ff merge on main of a branch that sets mode.txt (and optionally changes package.json), after a
// commit on main so the merge has two parents. The fake daemon behaves by mode.txt, so reverting the merge fixes it.
function makeMerge(mode: string, touchPackage = false): RestartRequest {
  writeFileSync(join(repo, "mode.txt"), "ok\n");
  writeFileSync(join(repo, "package.json"), "{}\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-m", "base");
  sh(repo, "checkout", "-b", "feature");
  writeFileSync(join(repo, "mode.txt"), `${mode}\n`);
  if (touchPackage) writeFileSync(join(repo, "package.json"), '{ "name": "x" }\n');
  sh(repo, "add", "-A");
  sh(repo, "commit", "-m", "feature work");
  sh(repo, "checkout", "main");
  writeFileSync(join(repo, "other.txt"), "other\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-m", "other work on main");
  sh(repo, "merge", "--no-ff", "-m", "Merge feature", "feature");
  mergeRequest = {
    mergeCommit: sh(repo, "rev-parse", "HEAD"),
    workItemId: itemId,
    preMergeHead: sh(repo, "rev-parse", "HEAD^1"),
    requestedAt: new Date().toISOString(),
  };
  return mergeRequest;
}

const commits = (...args: string[]) => sh(repo, "log", "--format=%H", ...args).split("\n");

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
    openDb: () => openDb(dbFile),
    spawn: (cwd, onOutput) => {
      const behavior = behaviors[spawned.length] ?? "healthy";
      if (behavior === "exit:75") {
        if (mergeRequest) writeRestartRequest(stateDir, mergeRequest);
        else writeRequest();
      }
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

  it("by default reverts a single-parent commit and carries on when the item is not done", async () => {
    writeRequest();
    const db = openDb(dbFile);
    db.prepare("UPDATE work_items SET status = 'queued' WHERE id = ?").run(itemId);
    db.close();
    const h = harness(["exit:1", "exit:0"]);
    expect(await runSupervisor(h.deps)).toBe(0);
    expect(h.spawned).toHaveLength(2);
    expect(h.stderr()).toContain("could not mark");
    expect(existsSync(join(repo, "notes.md"))).toBe(false);
    expect(itemStatus().status).toBe("queued");
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

describe("rollback", () => {
  const revertCommits = () => commits("--grep=^Revert").length;

  async function runUntilHealthy(h: Harness, starts: number) {
    const done = runSupervisor(h.deps);
    await waitFor(() => h.spawned.length === starts && existsSync(join(stateDir, "ready.json")), "a healthy start");
    h.signal();
    return await done;
  }

  it("reverts a merge whose daemon crashes, marks the item failed and starts a healthy daemon", async () => {
    const request = makeMerge("broken");
    const before = commits();
    const h = harness(["exit:75", "by-repo", "by-repo"]);
    expect(await runUntilHealthy(h, 3)).toBe(0);

    expect(existsSync(restartPath(stateDir))).toBe(false);
    expect(readFileSync(join(repo, "mode.txt"), "utf8")).toBe("ok\n");
    const item = itemStatus();
    expect(item.status).toBe("failed");
    expect(item.error).toMatch(
      /^Its merge stopped the hatchling from restarting, so it was reverted\. Last daemon output: [\s\S]*boom broken/,
    );

    // The history keeps the merge and gains the revert; nothing earlier is dropped (no reset).
    const firstParent = commits("--first-parent", "main");
    expect(firstParent).toContain(request.mergeCommit);
    expect(sh(repo, "log", "-1", "--format=%s", "main")).toMatch(/^Revert/);
    expect(firstParent).toHaveLength(before.filter((c) => firstParent.includes(c)).length + 1);
    const after = commits();
    for (const c of before) expect(after).toContain(c);
    expect(revertCommits()).toBe(1);
  });

  it("rolls back a daemon that never becomes ready", async () => {
    makeMerge("silent");
    const h = harness(["exit:75", "by-repo", "by-repo"], {
      timing: { readyTimeoutMs: 150, stableMs: 60, restartDelayMs: 5, killGraceMs: 1000, pollMs: 5 },
    });
    expect(await runUntilHealthy(h, 3)).toBe(0);
    expect(isPidAlive((h.spawned[1] as ChildHandle).pid)).toBe(false);
    expect(revertCommits()).toBe(1);
    expect(itemStatus().status).toBe("failed");
    expect(existsSync(restartPath(stateDir))).toBe(false);
  });

  it("returns 1 without reverting when the checkout is dirty", async () => {
    makeMerge("broken");
    const head = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "junk.txt"), "not mine\n");
    const h = harness(["exit:75", "by-repo"]);
    expect(await runSupervisor(h.deps)).toBe(1);
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
    expect(itemStatus().status).toBe("done");
    expect(h.stderr()).toContain("junk.txt");
    expect(h.spawned).toHaveLength(2);
  });

  it("does not count a change under .adaegg/ as a dirty checkout", async () => {
    makeMerge("broken");
    writeFileSync(join(stateDir, "scratch.txt"), "state\n");
    const h = harness(["exit:75", "by-repo", "by-repo"]);
    expect(await runUntilHealthy(h, 3)).toBe(0);
    expect(revertCommits()).toBe(1);
  });

  it("returns 1 and leaves a clean tree when the revert fails", async () => {
    makeMerge("broken");
    writeFileSync(join(repo, "mode.txt"), "broken again\n");
    sh(repo, "commit", "-am", "later change to the same line");
    const head = sh(repo, "rev-parse", "HEAD");
    const h = harness(["exit:75", "by-repo"]);
    expect(await runSupervisor(h.deps)).toBe(1);
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
    expect(sh(repo, "status", "--porcelain")).toBe("");
    expect(h.stderr()).toContain("failed");
    expect(itemStatus().status).toBe("done");
    expect(h.spawned).toHaveLength(2);
  });

  it.each([
    [true, 2],
    [false, 0],
  ])("reruns setup on rollback only when package files changed (changed: %s)", async (touchPackage, calls) => {
    makeMerge("broken", touchPackage);
    const setupCalls: string[] = [];
    const h = harness(["exit:75", "by-repo", "by-repo"], {
      config: { setup: "npm ci" },
      runSetup: (_root, command) => {
        setupCalls.push(command);
      },
    });
    expect(await runUntilHealthy(h, 3)).toBe(0);
    // Once for the probation start, once after the revert.
    expect(setupCalls).toHaveLength(calls);
  });

  it("does not revert twice for one request: a second failure is a plain crash bounded by the crash window", async () => {
    makeMerge("broken");
    const h = harness(["exit:75", "by-repo", "exit:1", "exit:1", "exit:1"]);
    expect(await runSupervisor(h.deps)).toBe(1);
    expect(revertCommits()).toBe(1);
    expect(h.spawned).toHaveLength(5);
    expect(h.stderr()).toContain("the hatchling won't start");
    expect(existsSync(restartPath(stateDir))).toBe(false);
  });
});
