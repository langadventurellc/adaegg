import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteReady,
  deleteRestartRequest,
  isPidAlive,
  RESTART_EXIT_CODE,
  readReady,
  readRestartRequest,
  readyPath,
  restartPath,
  touchesRestartPaths,
  writeReady,
  writeRestartRequest,
} from "./lifecycle.ts";

let dir: string;
let stateDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adaegg-lifecycle-"));
  stateDir = join(dir, "nested", "state");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("touchesRestartPaths", () => {
  it.each([
    "src/a.ts",
    "workflows/x.yaml",
    "prompts/p.md",
    "bin/hatch",
    "package.json",
    "package-lock.json",
    "adaegg.json",
  ])("is true for %s", (p) => {
    expect(touchesRestartPaths(["docs/a.md", p])).toBe(true);
  });

  it.each(["docs/src/a.md", "README.md", "docs/package.json", "source/a.ts", "srcs/a.ts"])("is false for %s", (p) => {
    expect(touchesRestartPaths([p])).toBe(false);
  });

  it("is false for no paths", () => {
    expect(touchesRestartPaths([])).toBe(false);
  });
});

describe("files", () => {
  it("uses fixed names and the restart exit code", () => {
    expect(restartPath("/s")).toBe("/s/restart.json");
    expect(readyPath("/s")).toBe("/s/ready.json");
    expect(RESTART_EXIT_CODE).toBe(75);
  });

  it("round-trips a restart request, creating the state dir", () => {
    expect(readRestartRequest(stateDir)).toBeNull();
    const request = {
      mergeCommit: "abc",
      workItemId: "id",
      preMergeHead: "def",
      requestedAt: new Date().toISOString(),
    };
    writeRestartRequest(stateDir, request);
    expect(readRestartRequest(stateDir)).toEqual(request);
    deleteRestartRequest(stateDir);
    expect(readRestartRequest(stateDir)).toBeNull();
  });

  it("throws a clear error on an invalid restart.json", () => {
    writeRestartRequest(stateDir, {
      mergeCommit: "a",
      workItemId: "b",
      preMergeHead: "c",
      requestedAt: new Date().toISOString(),
    });
    writeFileSync(restartPath(stateDir), "{nope");
    expect(() => readRestartRequest(stateDir)).toThrow(/restart\.json is not valid JSON/);
  });

  it("round-trips ready and treats missing or invalid as null", () => {
    expect(readReady(stateDir)).toBeNull();
    const ready = { pid: 42, startedAt: new Date().toISOString(), head: "abc" };
    writeReady(stateDir, ready);
    expect(readReady(stateDir)).toEqual(ready);
    writeFileSync(readyPath(stateDir), "garbage");
    expect(readReady(stateDir)).toBeNull();
    deleteReady(stateDir);
    deleteReady(stateDir);
    expect(readReady(stateDir)).toBeNull();
  });
});

describe("isPidAlive", () => {
  it("is true for this process and false for a dead pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
