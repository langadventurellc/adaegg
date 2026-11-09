import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../engine/db.ts";
import { type CliIo, runCli } from "./main.ts";

// Every call opens and migrates a fresh database; on a slow disk that alone nears the 5s default.
vi.setConfig({ testTimeout: 30_000 });

const marker = join(import.meta.dirname, "..", "..", "adaegg.json");
const binPath = join(import.meta.dirname, "..", "..", "bin", "hatch");

let base: string;
let repo: string;
let state: string;
let counter = 0;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "adaegg-cli-")));
  repo = join(base, "repo");
  state = join(base, "state");
  mkdirSync(repo);
  copyFileSync(marker, join(repo, "adaegg.json"));
  counter++;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

type Result = { code: number; out: string; err: string };

async function hatch(
  args: string[],
  opts: { stdin?: string; tty?: boolean; cwd?: string; stop?: CliIo["stop"] } = {},
): Promise<Result> {
  let out = "";
  let err = "";
  const stdin = Object.assign(Readable.from(opts.stdin === undefined ? [] : [opts.stdin]), {
    isTTY: opts.tty ?? false,
  });
  const io: CliIo = {
    stdout: {
      write: (t) => {
        out += t;
      },
    },
    stderr: {
      write: (t) => {
        err += t;
      },
    },
    stdin,
    cwd: opts.cwd ?? repo,
    env: { ADAEGG_STATE_DIR: state },
    ...(opts.stop === undefined ? {} : { stop: opts.stop }),
  };
  const code = await runCli(args, io);
  return { code, out, err };
}

async function add(args: string[], stdin?: string): Promise<string> {
  const r = await hatch(["add", ...args], stdin === undefined ? {} : { stdin });
  expect(r.code).toBe(0);
  const m = /^queued (\w{8})\n$/.exec(r.out);
  expect(m).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

function expectOneLineError(r: Result, pattern: RegExp) {
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  expect(r.err).toMatch(/^hatch: [^\n]+\n$/);
  expect(r.err).toMatch(pattern);
}

describe("add", () => {
  it("reads contents from --file relative to cwd", async () => {
    writeFileSync(join(repo, "body.md"), "from file");
    const id = await add(["T", "--file", "body.md"]);
    const shown = JSON.parse((await hatch(["show", id, "--json"])).out);
    expect(shown.contents).toBe("from file");
    expect(shown.title).toBe("T");
  });

  it("reads contents from stdin when it is not a TTY", async () => {
    const id = await add(["T"], "from stdin");
    expect(JSON.parse((await hatch(["show", id, "--json"])).out).contents).toBe("from stdin");
  });

  it("uses empty contents when stdin is a TTY", async () => {
    const r = await hatch(["add", "T"], { stdin: "ignored", tty: true });
    const id = r.out.slice(7, 15);
    expect(JSON.parse((await hatch(["show", id, "--json"])).out).contents).toBe("");
  });

  it("records blockers by id prefix, priority and parent", async () => {
    const a = await add(["A"]);
    const b = await add(["B", "--blocked-by", a, "--priority", "5", "--parent", a]);
    const shown = JSON.parse((await hatch(["show", b, "--json"])).out);
    expect(shown.priority).toBe(5);
    expect(shown.parentId.startsWith(a)).toBe(true);
    expect(shown.blockedBy).toHaveLength(1);
    expect(shown.blockedBy[0].startsWith(a)).toBe(true);
  });

  it.each([["--priority", "-1"], ["--priority=-1"]])("stores a negative priority given as %j", async (...flag) => {
    const id = await add(["later", ...flag]);
    expect(JSON.parse((await hatch(["show", id, "--json"])).out).priority).toBe(-1);
    expect((await hatch(["list"])).out).toContain("p-1");
  });

  it("accepts several --blocked-by", async () => {
    const a = await add(["A"]);
    const b = await add(["B"]);
    const c = await add(["C", "--blocked-by", a, "--blocked-by", b]);
    expect(JSON.parse((await hatch(["show", c, "--json"])).out).blockedBy).toHaveLength(2);
  });

  it("stores kind item by default", async () => {
    const id = await add(["A"]);
    expect(JSON.parse((await hatch(["show", id, "--json"])).out).kind).toBe("item");
  });

  it.each(["item", "request"])("stores --kind %s", async (kind) => {
    const id = await add(["A", "--kind", kind]);
    expect(JSON.parse((await hatch(["show", id, "--json"])).out).kind).toBe(kind);
  });

  it.each(["verify", "nonsense"])("rejects --kind %s", async (kind) => {
    expectOneLineError(await hatch(["add", "A", "--kind", kind]), /--kind must be item or request/);
  });

  it("rejects --kind without a value", async () => {
    const r = await hatch(["add", "A", "--kind"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/kind/);
  });
});

describe("list, show, cancel, retry, status", () => {
  it("lists human lines with a blocked annotation", async () => {
    const a = await add(["First"]);
    const b = await add(["Second", "--blocked-by", a, "--priority", "2"]);
    const r = await hatch(["list"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${a}  queued  p0  First\n${b}  queued  p2  Second  (blocked by ${a})\n`);
  });

  it("lists json with blockedBy and filters by status", async () => {
    const a = await add(["First"]);
    await add(["Second", "--blocked-by", a]);
    await hatch(["cancel", a]);
    const all = JSON.parse((await hatch(["list", "--json"])).out);
    expect(all).toHaveLength(2);
    expect(all[1].blockedBy).toHaveLength(1);
    const cancelled = JSON.parse((await hatch(["list", "--status", "cancelled", "--json"])).out);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].title).toBe("First");
  });

  it("shows all fields in human form", async () => {
    const a = await add(["First"], "body text");
    const b = await add(["Second"], "x");
    await hatch(["cancel", b]);
    const r = await hatch(["show", a]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("title: First");
    expect(r.out).toContain("status: queued");
    expect(r.out).toContain("blocked by: -");
    expect(r.out).toContain("contents:\nbody text");
  });

  it("cancels and retries", async () => {
    const a = await add(["A"]);
    expect((await hatch(["cancel", a])).out).toBe(`cancelled ${a}\n`);
    expect((await hatch(["retry", a])).out).toBe(`queued ${a}\n`);
  });

  it("counts every status including zeros", async () => {
    const a = await add(["A"]);
    await add(["B"]);
    await hatch(["cancel", a]);
    const r = await hatch(["status"]);
    expect(r.out).toBe("queued  1\nin_progress  0\ndone  0\nfailed  0\ncancelled  1\ndaemon  down\n");
  });

  it("reports the daemon as up when ready.json names a live pid", async () => {
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "ready.json"),
      JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", head: "abc" }),
    );
    const r = await hatch(["status"]);
    expect(r.out.endsWith(`daemon  up (pid ${process.pid})\n`)).toBe(true);
  });

  it("shows the ui url after the daemon line when ready.json has one", async () => {
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "ready.json"),
      JSON.stringify({
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
        head: "abc",
        url: "http://127.0.0.1:4747",
      }),
    );
    const r = await hatch(["status"]);
    expect(r.out.endsWith(`daemon  up (pid ${process.pid})\nui  http://127.0.0.1:4747\n`)).toBe(true);
  });

  it("shows no ui line when the daemon is down, even if ready.json has a url", async () => {
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "ready.json"),
      JSON.stringify({
        pid: 2147483646,
        startedAt: "2026-01-01T00:00:00.000Z",
        head: "abc",
        url: "http://127.0.0.1:4747",
      }),
    );
    const r = await hatch(["status"]);
    expect(r.out.endsWith("daemon  down\n")).toBe(true);
  });

  it("reports the daemon as down when ready.json names a dead pid", async () => {
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "ready.json"),
      JSON.stringify({ pid: 2147483646, startedAt: "2026-01-01T00:00:00.000Z", head: "abc" }),
    );
    const r = await hatch(["status"]);
    expect(r.out.endsWith("cancelled  0\ndaemon  down\n")).toBe(true);
  });

  it("rejects an argument to start", async () => {
    expectOneLineError(await hatch(["start", "now"]), /unexpected argument: now/);
  });
});

function writeReady(pid: number) {
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "ready.json"), JSON.stringify({ pid, startedAt: "2026-01-01T00:00:00.000Z", head: "abc" }));
}

describe("stop", () => {
  it("says the daemon is down without ready.json and signals nothing", async () => {
    const kill = vi.fn();
    const r = await hatch(["stop"], { stop: { kill } });
    expect(r).toEqual({ code: 0, out: "daemon  down\n", err: "" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("says the daemon is down when ready.json names a dead pid", async () => {
    writeReady(4242);
    const kill = vi.fn();
    const r = await hatch(["stop"], { stop: { kill, isPidAlive: () => false } });
    expect(r).toEqual({ code: 0, out: "daemon  down\n", err: "" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("sends SIGTERM once, waits until the pid is gone, then prints stopped", async () => {
    writeReady(4242);
    const kill = vi.fn();
    let polls = 0;
    const sleep = vi.fn(async () => {});
    const r = await hatch(["stop"], {
      stop: { kill, sleep, isPidAlive: () => polls++ < 4 },
    });
    expect(r).toEqual({ code: 0, out: "stopped\n", err: "" });
    expect(kill.mock.calls).toEqual([[4242, "SIGTERM"]]);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it("times out with a message naming the pid and never sends SIGKILL", async () => {
    writeReady(4242);
    const kill = vi.fn();
    let clock = 0;
    const r = await hatch(["stop"], {
      stop: {
        kill,
        isPidAlive: () => true,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^hatch: [^\n]+\n$/);
    expect(r.err).toContain("4242");
    expect(r.err).toContain("did not stop");
    expect(r.err).toContain("kill");
    expect(kill.mock.calls).toEqual([[4242, "SIGTERM"]]);
    expect(clock).toBeGreaterThanOrEqual(60_000);
  });

  it("treats ESRCH from the signal as stopped", async () => {
    writeReady(4242);
    const kill = () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    const r = await hatch(["stop"], { stop: { kill, isPidAlive: () => true } });
    expect(r).toEqual({ code: 0, out: "stopped\n", err: "" });
  });

  it("is in the help and rejects an argument", async () => {
    expect((await hatch(["--help"])).out).toContain("  stop ");
    expectOneLineError(await hatch(["stop", "extra"]), /unexpected argument: extra/);
  });
});

describe("delivery in list and show", () => {
  function setRow(idShort: string, set: string, ...params: (string | null)[]) {
    const db = openDb(join(state, "hatch.db"));
    db.prepare(`UPDATE work_items SET ${set} WHERE id LIKE ?`).run(...params, `${idShort}%`);
    db.close();
  }
  function fullId(idShort: string): string {
    const db = openDb(join(state, "hatch.db"));
    const id = (db.prepare("SELECT id FROM work_items WHERE id LIKE ?").get(`${idShort}%`) as { id: string }).id;
    db.close();
    return id;
  }
  async function seedRequest(childStatus: string) {
    const req = await add(["Req", "--kind", "request"]);
    const child = await add(["Step"]);
    setRow(req, "status = 'done'");
    setRow(child, "parent_id = ?, status = ?", fullId(req), childStatus);
    return { req, child };
  }

  it("shows a request with an unfinished child as building", async () => {
    const { req, child } = await seedRequest("in_progress");
    const r = await hatch(["list"]);
    expect(r.out).toContain(`${req}  done  building 0/1  p0  Req\n`);
    expect(r.out).toContain(`${child}  in_progress  p0  Step\n`);
  });

  it("shows a request whose children are all done as delivered", async () => {
    const { req } = await seedRequest("done");
    expect((await hatch(["list"])).out).toContain(`${req}  done  delivered 1/1  p0  Req\n`);
  });

  it("keeps the building state under --status done", async () => {
    const { req } = await seedRequest("in_progress");
    expect((await hatch(["list", "--status", "done"])).out).toBe(`${req}  done  building 0/1  p0  Req\n`);
  });

  it("leaves list --json without a delivery field", async () => {
    await seedRequest("in_progress");
    const json = JSON.parse((await hatch(["list", "--json"])).out) as Record<string, unknown>[];
    expect(json).toHaveLength(2);
    for (const row of json) expect(Object.keys(row)).not.toContain("delivery");
    expect(JSON.stringify(json)).not.toContain("building");
  });

  it("prints a delivery line for a request in show, not for an item", async () => {
    const { req, child } = await seedRequest("in_progress");
    expect((await hatch(["show", req])).out).toContain("status: done\ndelivery: building 0/1\n");
    expect((await hatch(["show", child])).out).not.toContain("delivery:");
    expect(JSON.parse((await hatch(["show", req, "--json"])).out)).not.toHaveProperty("delivery");
  });
});

// Records a running run (at `checks`) with two finished node runs for the item, straight in the database.
function seedRun(itemShort: string, runId: string, startedAt: string) {
  const db = openDb(join(state, "hatch.db"));
  const itemId = (db.prepare("SELECT id FROM work_items WHERE id LIKE ?").get(`${itemShort}%`) as { id: string }).id;
  db.prepare(
    "INSERT INTO runs (id, work_item_id, workflow_id, status, current_node, state, started_at) VALUES (?, ?, 'wf', 'running', 'checks', '{}', ?)",
  ).run(runId, itemId, startedAt);
  db.prepare(
    "INSERT INTO node_runs (run_id, node_id, attempt, outcome, problem, cost_usd, started_at) VALUES (?, 'branch', 1, 'ok', NULL, 0.5, ?)",
  ).run(runId, startedAt);
  db.prepare(
    "INSERT INTO node_runs (run_id, node_id, attempt, outcome, problem, started_at) VALUES (?, 'checks', 1, 'failed', 'tests broke', ?)",
  ).run(runId, startedAt);
  db.close();
  return itemId;
}

describe("runs", () => {
  it("shows an item's runs and node runs in text and json", async () => {
    const a = await add(["First"]);
    seedRun(a, "11111111-aaaa", "2026-01-01T00:00:00.000Z");
    const text = (await hatch(["show", a])).out;
    expect(text).toContain("runs:\n  11111111  wf  running  checks\n");
    expect(text).toContain("    branch  attempt 1  ok  problem: -  cost: $0.5000");
    expect(text).toContain("    checks  attempt 1  failed  problem: tests broke  cost: -");
    const json = JSON.parse((await hatch(["show", a, "--json"])).out);
    expect(json.runs).toHaveLength(1);
    expect(json.runs[0]).toMatchObject({ id: "11111111-aaaa", workflowId: "wf", currentNode: "checks" });
    expect(json.runs[0].nodeRuns.map((n: { nodeId: string }) => n.nodeId)).toEqual(["branch", "checks"]);
  });

  it("shows no runs section for an item without runs", async () => {
    const a = await add(["First"]);
    expect((await hatch(["show", a])).out).not.toContain("runs:");
    expect(JSON.parse((await hatch(["show", a, "--json"])).out).runs).toEqual([]);
  });

  it("lists runs newest first, one line each, and honours --limit", async () => {
    const a = await add(["First"]);
    seedRun(a, "11111111-aaaa", "2026-01-01T00:00:00.000Z");
    seedRun(a, "22222222-bbbb", "2026-01-02T00:00:00.000Z");
    const r = await hatch(["runs"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`22222222  wf  running  checks  ${a}\n11111111  wf  running  checks  ${a}\n`);
    expect((await hatch(["runs", "--limit", "1"])).out).toBe(`22222222  wf  running  checks  ${a}\n`);
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects --limit %s", async (value) => {
    expectOneLineError(await hatch(["runs", `--limit=${value}`]), /--limit must be a positive integer/);
  });
});

describe("errors", () => {
  it("rejects an unknown id", async () => {
    await add(["A"]);
    expectOneLineError(await hatch(["show", "deadbeef"]), /no work item matches/);
  });

  it("rejects a too-short prefix", async () => {
    expectOneLineError(await hatch(["show", "ab"]), /too short/);
  });

  it("rejects a bad --status", async () => {
    expectOneLineError(await hatch(["list", "--status", "nope"]), /invalid status/);
  });

  it("rejects a non-integer --priority", async () => {
    expectOneLineError(await hatch(["add", "T", "--priority", "1.5"]), /integer/);
  });

  it("rejects a missing title", async () => {
    expectOneLineError(await hatch(["add"]), /missing title/);
  });

  it("rejects a missing --file", async () => {
    expectOneLineError(await hatch(["add", "T", "--file", "nope.md"]), /cannot read file/);
  });

  it("rejects cancelling a non-queued item", async () => {
    const a = await add(["A"]);
    await hatch(["cancel", a]);
    expectOneLineError(await hatch(["cancel", a]), /cannot cancel/);
  });

  it("rejects an unknown blocker", async () => {
    expectOneLineError(await hatch(["add", "T", "--blocked-by", "deadbeef"]), /blocker not found/);
  });

  it("explains too-short and ambiguous --blocked-by prefixes and adds nothing", async () => {
    const db = openDb(join(state, "hatch.db"));
    for (const id of ["abcd1111-0000", "abcd2222-0000"]) {
      db.prepare("INSERT INTO work_items (id, title, created_at, updated_at) VALUES (?, 't', 'x', 'x')").run(id);
    }
    db.close();
    expectOneLineError(await hatch(["add", "T", "--blocked-by", "abc"]), /too short/);
    expectOneLineError(await hatch(["add", "T", "--blocked-by", "abcd"]), /ambiguous id prefix abcd/);
    const listed = JSON.parse((await hatch(["list", "--json"])).out) as unknown[];
    expect(listed).toHaveLength(2);
  });

  it("rejects an unknown option", async () => {
    expectOneLineError(await hatch(["status", "--bogus"]), /bogus/);
  });

  it("reports a missing adaegg.json", async () => {
    const bare = join(base, "bare");
    mkdirSync(bare);
    expectOneLineError(await hatch(["status"], { cwd: bare }), /no adaegg\.json/);
  });
});

describe("help", () => {
  it("prints usage and returns 0 for --help and -h", async () => {
    for (const flag of ["--help", "-h"]) {
      const r = await hatch([flag]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Usage: hatch");
    }
  });

  it("prints help to stderr and returns 1 for an unknown command", async () => {
    const r = await hatch(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("Usage: hatch");
  });

  it("prints help to stderr and returns 1 for no command", async () => {
    const r = await hatch([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Usage: hatch");
  });
});

describe("bin/hatch", () => {
  it("runs from a linked worktree against the shared queue", () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });
    git(repo, "init", "-q");
    git(repo, "add", "adaegg.json");
    git(repo, "commit", "-q", "-m", "init");
    const wt = join(base, `wt${counter}`);
    git(repo, "worktree", "add", "-q", wt, "-b", "wt");
    const env = { ...process.env, ADAEGG_STATE_DIR: state };
    const run = (cwd: string, ...args: string[]) =>
      execFileSync("node", [binPath, ...args], { cwd, env, encoding: "utf8", input: "" });
    const queued = run(wt, "add", "From worktree");
    expect(queued).toMatch(/^queued \w{8}\n$/);
    expect(run(repo, "list")).toContain("From worktree");
    expect(run(wt, "status")).toContain("queued  1");
  });
});
