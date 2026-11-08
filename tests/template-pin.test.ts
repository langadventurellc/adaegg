import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const readPackage = (path: string): PackageJson =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as PackageJson;

const root = readPackage("../package.json");
const template = readPackage("../hatchling/package.json");

const versionOf = (pkg: PackageJson, name: string): string | undefined =>
  pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];

const shared = [
  "@anthropic-ai/claude-agent-sdk",
  "@biomejs/biome",
  "typescript",
  "vite",
  "vitest",
  "zod",
  "yaml",
  "@types/node",
];

describe("hatchling template", () => {
  it.each(shared)("pins %s to the same exact version as the root", (name) => {
    const rootVersion = versionOf(root, name);
    const templateVersion = versionOf(template, name);
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(templateVersion).toBe(rootVersion);
  });

  it("only names scripts that exist in its check script", () => {
    const scripts = template.scripts ?? {};
    const segments = (scripts.check ?? "").split("&&").map((s) => s.trim());
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      const match = /^npm (?:run )?([\w:-]+)$/.exec(segment);
      expect(match, `unrecognised segment: ${segment}`).not.toBeNull();
      expect(scripts, `missing script: ${match?.[1]}`).toHaveProperty(match?.[1] ?? "");
    }
  });
});
