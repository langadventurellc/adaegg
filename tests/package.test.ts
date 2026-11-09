import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { copyTemplate } from "../installer/init.ts";

interface PackageJson {
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  license?: string;
  dependencies?: Record<string, string>;
  engines?: { node?: string };
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const templateDir = join(repoRoot, "hatchling");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageJson;

describe("root package.json", () => {
  it("is publishable with no runtime dependencies", () => {
    expect(pkg).not.toHaveProperty("private");
    expect(pkg.license).toBe("MIT");
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(pkg.engines?.node).toBe(">=24");
    expect(pkg.files).toEqual(["bin", "dist/installer", "hatchling", "README.md", "LICENSE"]);
  });

  it("points bin.adaegg at a script with a node shebang", () => {
    const bin = pkg.bin?.adaegg ?? "";
    expect(bin).not.toBe("");
    expect(existsSync(join(repoRoot, bin))).toBe(true);
    expect(readFileSync(join(repoRoot, "bin/adaegg.mjs"), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});

describe("npm pack", () => {
  it("lists the template and leaves out build output and state", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out) as { files: { path: string }[] }[];
    const paths = (parsed[0]?.files ?? []).map((f) => f.path);
    for (const expected of [
      "package.json",
      "bin/adaegg.mjs",
      "hatchling/adaegg.json",
      "hatchling/package.json",
      "hatchling/bin/hatch",
      "hatchling/src/cli/main.ts",
      "hatchling/workflows/implement.yaml",
    ]) {
      expect(paths).toContain(expected);
    }
    expect(paths.filter((p) => p.includes("node_modules/"))).toEqual([]);
    expect(paths.filter((p) => p.startsWith("hatchling/dist/"))).toEqual([]);
    expect(paths.filter((p) => p.includes(".adaegg/"))).toEqual([]);
    expect(paths.filter((p) => p.includes("pnpm-lock.yaml"))).toEqual([]);
  }, 60_000);
});

describe("generated tree", () => {
  const temp = mkdtempSync(join(tmpdir(), "adaegg-package-"));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it("is lint-clean and typechecks", () => {
    const target = join(temp, "repo");
    copyTemplate(templateDir, target);
    const lock = {
      name: "hatchling",
      version: "0.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "hatchling", version: "0.0.0" },
        "node_modules/example": {
          version: "1.0.0",
          cpu: ["x64", "arm64"],
          os: ["linux"],
        },
      },
    };
    writeFileSync(join(target, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    const home = join(temp, "home");
    mkdirSync(home);
    writeFileSync(join(temp, "gitconfig"), "");
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(temp, "gitconfig"),
    };
    execFileSync("git", ["init", "-q"], { cwd: target, env });
    symlinkSync(join(repoRoot, "node_modules"), join(target, "node_modules"));
    const bin = (name: string) => join(repoRoot, "node_modules/.bin", name);
    execFileSync(bin("biome"), ["check", "--error-on-warnings", "."], { cwd: target, env });
    execFileSync(bin("tsc"), ["-p", "tsconfig.json"], { cwd: target, env });
  }, 120_000);
});
