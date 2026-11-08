import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openDb } from "../db.ts";
import { addWorkItem, claimNext, failWorkItem, finishWorkItem } from "../store.ts";
import { buildTemplateRepo, copyRepo, makeCtx, removeAllRepos, removeCopies, sh } from "./test-repo.ts";
import { tidyNode } from "./tidy.ts";

let template: string;
beforeAll(() => {
  template = buildTemplateRepo();
});
afterEach(() => {
  vi.restoreAllMocks();
  removeCopies();
});
afterAll(removeAllRepos);

const NOW = new Date("2026-06-01T12:00:00Z");
const DAY = 86_400_000;

function run(root: string, db: DatabaseSync) {
  const ctx = { ...makeCtx(root, { db }), config: { retainLogDays: 30 }, now: () => NOW };
  return tidyNode.run(ctx);
}

// Adds an item and moves it to `status`; gives it a worktree on a hatch branch.
function item(db: DatabaseSync, root: string, status: "done" | "failed" | "in_progress", worktree = true) {
  const added = addWorkItem(db, { title: `item ${status}` });
  claimNext(db, "item");
  if (status === "done") finishWorkItem(db, added.id);
  if (status === "failed") failWorkItem(db, added.id, "boom");
  const id8 = added.id.slice(0, 8);
  const branch = `hatch/${id8}-x`;
  const path = join(root, ".adaegg", "worktrees", id8);
  if (worktree) sh(root, "worktree", "add", "-b", branch, path, "main");
  return { id: added.id, branch, path };
}

function commitOn(path: string): void {
  writeFileSync(join(path, "new.txt"), "x\n");
  sh(path, "add", "-A");
  sh(path, "commit", "-m", "work");
}

function output(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c) => String(c[0])).join("");
}

describe("tidy node worktrees", () => {
  it("removes a merged done item's worktree and branch", async () => {
    const root = copyRepo(template);
    const db = openDb(":memory:");
    const a = item(db, root, "done");
    commitOn(a.path);
    sh(root, "merge", a.branch);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await run(root, db);
    expect(result.outcome).toBe("tidied");
    expect(existsSync(a.path)).toBe(false);
    expect(sh(root, "worktree", "list")).not.toContain(a.path);
    expect(sh(root, "branch", "--list", "hatch/*")).toBe("");
    expect(output(spy)).toContain("tidy: removed 1 worktrees, 1 branches, 0 log directories (skipped 0)\n");
  });

  it("leaves failed and in-progress items alone", async () => {
    const root = copyRepo(template);
    const db = openDb(":memory:");
    const failed = item(db, root, "failed");
    const active = item(db, root, "in_progress");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await run(root, db);
    expect(result.outcome).toBe("tidied");
    for (const i of [failed, active]) {
      expect(existsSync(i.path)).toBe(true);
      expect(sh(root, "branch", "--list", i.branch)).toContain(i.branch);
    }
  });

  it("skips a done item whose branch is not merged", async () => {
    const root = copyRepo(template);
    const db = openDb(":memory:");
    const a = item(db, root, "done");
    commitOn(a.path);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await run(root, db);
    expect(result.outcome).toBe("tidied");
    expect(existsSync(a.path)).toBe(true);
    expect(sh(root, "branch", "--list", a.branch)).toContain(a.branch);
    expect(output(spy)).toContain("removed 0 worktrees, 0 branches, 0 log directories (skipped 1)");
  });

  it("is fine with a done item without a worktree", async () => {
    const root = copyRepo(template);
    const db = openDb(":memory:");
    item(db, root, "done", false);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect((await run(root, db)).outcome).toBe("tidied");
  });

  it("changes nothing on a second run", async () => {
    const root = copyRepo(template);
    const db = openDb(":memory:");
    const a = item(db, root, "done");
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect((await run(root, db)).outcome).toBe("tidied");
    expect(existsSync(a.path)).toBe(false);
    spy.mockClear();
    expect((await run(root, db)).outcome).toBe("tidied");
    expect(output(spy)).toContain("removed 0 worktrees, 0 branches, 0 log directories (skipped 0)");
  });
});

describe("tidy node logs", () => {
  function logDir(root: string, name: string, ageDays: number): string {
    const dir = join(root, ".adaegg", "logs", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "node-1.jsonl"), "{}\n");
    const when = new Date(NOW.getTime() - ageDays * DAY);
    utimesSync(dir, when, when);
    return dir;
  }

  it("removes old log directories, keeps recent ones, running runs and files", async () => {
    const root = copyRepo(template);
    const db = openDb(":memory:");
    const added = addWorkItem(db, { title: "t" });
    db.prepare(
      "INSERT INTO runs (id, work_item_id, workflow_id, status, state, started_at) VALUES (?, ?, 'w', 'running', '{}', ?)",
    ).run("deadbeef00000000", added.id, NOW.toISOString());
    const old = logDir(root, "11111111", 40);
    const recent = logDir(root, "22222222", 5);
    const live = logDir(root, "deadbeef", 90);
    writeFileSync(join(root, ".adaegg", "logs", "daemon.log"), "x\n");
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await run(root, db);
    expect(result.outcome).toBe("tidied");
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(join(root, ".adaegg", "logs", "daemon.log"))).toBe(true);
    expect(output(spy)).toContain("1 log directories");
  });

  it("is fine without a logs directory", async () => {
    const root = copyRepo(template);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect((await run(root, openDb(":memory:"))).outcome).toBe("tidied");
  });
});
