import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumingPath,
  deleteReady,
  deleteRestartRequest,
  deleteRestartRequestIfUnchanged,
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

  it("round-trips ready with and without a url", () => {
    const ready = { pid: 42, startedAt: new Date().toISOString(), head: "abc" };
    writeReady(stateDir, { ...ready, url: "http://127.0.0.1:4747" });
    expect(readReady(stateDir)).toEqual({ ...ready, url: "http://127.0.0.1:4747" });
    writeReady(stateDir, ready);
    expect(readReady(stateDir)?.url).toBeUndefined();
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

describe("deleteRestartRequestIfUnchanged", () => {
  const make = (mergeCommit: string) => ({
    mergeCommit,
    workItemId: "id",
    preMergeHead: "def",
    requestedAt: "2026-01-01T00:00:00.000Z",
  });
  const older = make("old");
  const newer = make("new");

  it("consumes the same request", () => {
    writeRestartRequest(stateDir, older);
    expect(deleteRestartRequestIfUnchanged(stateDir, older)).toBe(true);
    expect(existsSync(restartPath(stateDir))).toBe(false);
    expect(existsSync(consumingPath(stateDir))).toBe(false);
  });

  it("returns true and creates nothing when there is no request", () => {
    mkdirSync(stateDir, { recursive: true });
    expect(deleteRestartRequestIfUnchanged(stateDir, older)).toBe(true);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("keeps a different request already on disk", () => {
    writeRestartRequest(stateDir, newer);
    expect(deleteRestartRequestIfUnchanged(stateDir, older)).toBe(false);
    expect(readRestartRequest(stateDir)).toEqual(newer);
    expect(existsSync(consumingPath(stateDir))).toBe(false);
  });

  it("keeps a request written between the take and the decision", () => {
    writeRestartRequest(stateDir, older);
    const result = deleteRestartRequestIfUnchanged(stateDir, older, {
      afterTake: () => writeRestartRequest(stateDir, newer),
    });
    expect(result).toBe(true);
    expect(readRestartRequest(stateDir)).toEqual(newer);
    expect(existsSync(consumingPath(stateDir))).toBe(false);
  });

  it("does not overwrite a request written in the gap when the taken one differs", () => {
    const other = make("other");
    writeRestartRequest(stateDir, other);
    const result = deleteRestartRequestIfUnchanged(stateDir, older, {
      afterTake: () => writeRestartRequest(stateDir, newer),
    });
    expect(result).toBe(false);
    expect(readRestartRequest(stateDir)).toEqual(newer);
    expect(existsSync(consumingPath(stateDir))).toBe(false);
  });

  it("leaves a normal restart.json for a write after the call", () => {
    writeRestartRequest(stateDir, older);
    expect(deleteRestartRequestIfUnchanged(stateDir, older)).toBe(true);
    writeRestartRequest(stateDir, newer);
    expect(readRestartRequest(stateDir)).toEqual(newer);
  });

  it("restores invalid JSON byte for byte", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(restartPath(stateDir), "{nope");
    expect(deleteRestartRequestIfUnchanged(stateDir, older)).toBe(false);
    expect(readFileSync(restartPath(stateDir), "utf8")).toBe("{nope");
    expect(existsSync(consumingPath(stateDir))).toBe(false);
  });
});

describe("isPidAlive", () => {
  it("is true for this process and false for a dead pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
