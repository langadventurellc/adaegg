import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listScannedFiles, scanTree } from "../scripts/public-scan.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("the repository is safe to publish", () => {
  it("has no secret-shaped strings or private names", () => {
    const findings = scanTree(root).map((f) => `${f.source}:${f.line} ${f.rule} ${f.sample}`);
    expect(findings).toEqual([]);
  });

  it("scans a real file list, including the entry points", () => {
    const files = listScannedFiles(root);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("bin/adaegg.mjs");
    expect(files).toContain("hatchling/bin/hatch");
  });
});
