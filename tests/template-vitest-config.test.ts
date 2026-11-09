import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../hatchling/vitest.config.ts", import.meta.url), "utf8");

const timeoutOf = (key: string): number => {
  const match = new RegExp(`${key}:\\s*([\\d_]+)`).exec(config);
  return Number((match?.[1] ?? "").replaceAll("_", ""));
};

describe("hatchling vitest config", () => {
  it.each(["testTimeout", "hookTimeout"])("sets %s to at least 30 s", (key) => {
    expect(timeoutOf(key)).toBeGreaterThanOrEqual(30_000);
  });
});
