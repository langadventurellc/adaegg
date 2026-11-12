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
    expect(loadConfig(dir)).toEqual({
      schema: 1,
      baseBranch: "main",
      checks: "npm run check",
      setup: "npm ci",
      checksTimeoutMinutes: 20,
      maxConcurrentRuns: 1,
      models: { implement: "sonnet", review: "sonnet", chat: "sonnet" },
      ui: { enabled: true, port: 4747 },
    });
  });

  it("defaults the ui settings that are not named", () => {
    writeFileSync(join(dir, "adaegg.json"), '{ "schema": 1, "ui": { "port": 0 } }');
    expect(loadConfig(dir).ui).toEqual({ enabled: true, port: 0 });
  });

  it.each(["70000", "-1", "1.5"])("rejects ui.port %s", (port) => {
    writeFileSync(join(dir, "adaegg.json"), `{ "schema": 1, "ui": { "port": ${port} } }`);
    expect(() => loadConfig(dir)).toThrow("ui.port");
  });

  it("defaults a model that is not named and accepts overrides", () => {
    writeFileSync(join(dir, "adaegg.json"), '{ "schema": 1, "models": { "review": "opus" } }');
    expect(loadConfig(dir).models).toEqual({ implement: "sonnet", review: "opus", chat: "sonnet" });
  });

  it("keeps an explicit models.chat and defaults the other keys", () => {
    writeFileSync(join(dir, "adaegg.json"), '{ "schema": 1, "models": { "chat": "haiku" } }');
    expect(loadConfig(dir).models).toEqual({ implement: "sonnet", review: "sonnet", chat: "haiku" });
  });

  it("rejects a model that is not a string", () => {
    writeFileSync(join(dir, "adaegg.json"), '{ "schema": 1, "models": { "implement": 3 } }');
    expect(() => loadConfig(dir)).toThrow("models.implement");
  });

  it("accepts overrides, including an empty setup", () => {
    writeFileSync(
      join(dir, "adaegg.json"),
      '{ "schema": 1, "baseBranch": "trunk", "setup": "", "maxConcurrentRuns": 3, "checksTimeoutMinutes": 5 }',
    );
    const config = loadConfig(dir);
    expect(config.baseBranch).toBe("trunk");
    expect(config.setup).toBe("");
    expect(config.maxConcurrentRuns).toBe(3);
    expect(config.checksTimeoutMinutes).toBe(5);
  });

  it.each([
    ['"maxConcurrentRuns": 0', "maxConcurrentRuns"],
    ['"checksTimeoutMinutes": -1.5', "checksTimeoutMinutes"],
    ['"checksTimeoutMinutes": -1', "checksTimeoutMinutes"],
    ['"baseBranch": ""', "baseBranch"],
    ['"checks": 5', "checks"],
  ])("rejects bad value %s", (field, name) => {
    writeFileSync(join(dir, "adaegg.json"), `{ "schema": 1, ${field} }`);
    expect(() => loadConfig(dir)).toThrow(name);
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
