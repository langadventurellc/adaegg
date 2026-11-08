import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "adaegg-config-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("parses a valid file", () => {
    writeFileSync(join(dir, "adaegg.json"), '{ "schema": 1 }');
    expect(loadConfig(dir)).toEqual({ schema: 1 });
  });

  it("names the file when missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "adaegg-config-empty-"));
    try {
      expect(() => loadConfig(empty)).toThrow(join(empty, "adaegg.json"));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("names the file when invalid", () => {
    writeFileSync(join(dir, "adaegg.json"), '{ "schema": 2 }');
    expect(() => loadConfig(dir)).toThrow(join(dir, "adaegg.json"));
    writeFileSync(join(dir, "adaegg.json"), "not json");
    expect(() => loadConfig(dir)).toThrow(/invalid .*adaegg\.json/);
  });
});
