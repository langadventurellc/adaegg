import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbPath, findRepoRoot, stateDir } from "./paths.ts";

let base: string;
let main: string;
let worktree: string;
let plain: string;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "adaegg-paths-")));
  main = join(base, "main");
  worktree = join(base, "wt");
  plain = join(base, "plain");
  mkdirSync(main);
  mkdirSync(join(plain, "a", "b"), { recursive: true });
  copyFileSync(join(import.meta.dirname, "..", "..", "adaegg.json"), join(plain, "adaegg.json"));
  copyFileSync(join(import.meta.dirname, "..", "..", "adaegg.json"), join(main, "adaegg.json"));
  git(main, "init", "-q");
  git(main, "add", "adaegg.json");
  git(main, "commit", "-q", "-m", "init");
  git(main, "worktree", "add", "-q", worktree, "-b", "wt");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("stateDir and dbPath", () => {
  it("defaults to <root>/.adaegg", () => {
    expect(stateDir("/r", {})).toBe(join("/r", ".adaegg"));
    expect(stateDir("/r", { ADAEGG_STATE_DIR: "" })).toBe(join("/r", ".adaegg"));
    expect(dbPath("/r", {})).toBe(join("/r", ".adaegg", "hatch.db"));
  });

  it("lets ADAEGG_STATE_DIR win", () => {
    expect(stateDir("/r", { ADAEGG_STATE_DIR: "/s" })).toBe("/s");
    expect(dbPath("/r", { ADAEGG_STATE_DIR: "/s" })).toBe(join("/s", "hatch.db"));
  });

  it("rejects a relative ADAEGG_STATE_DIR", () => {
    expect(() => stateDir("/r", { ADAEGG_STATE_DIR: "rel/dir" })).toThrow(/absolute/);
  });
});

describe("findRepoRoot", () => {
  it("walks up from a nested directory", () => {
    expect(realpathSync(findRepoRoot(join(plain, "a", "b")))).toBe(plain);
  });

  it("throws when there is no marker", () => {
    const none = mkdtempSync(join(tmpdir(), "adaegg-none-"));
    try {
      expect(() => findRepoRoot(none)).toThrow(`no adaegg.json found from ${none}`);
    } finally {
      rmSync(none, { recursive: true, force: true });
    }
  });

  it("returns a normal checkout itself", () => {
    expect(realpathSync(findRepoRoot(main))).toBe(main);
  });

  it("resolves a linked worktree to the main checkout", () => {
    expect(realpathSync(findRepoRoot(worktree))).toBe(main);
  });
});
