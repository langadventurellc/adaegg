import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const built = existsSync(join(repoRoot, "dist/installer/main.js"));

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("bin/adaegg.mjs", () => {
  it("tells the user to run pnpm build when the installer is not built", () => {
    tmp = mkdtempSync(join(tmpdir(), "adaegg-bin-"));
    mkdirSync(join(tmp, "bin"));
    copyFileSync(join(repoRoot, "bin/adaegg.mjs"), join(tmp, "bin/adaegg.mjs"));

    const result = spawnSync(process.execPath, [join(tmp, "bin/adaegg.mjs"), "--help"], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm build");
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it.skipIf(!built)("runs the built installer", () => {
    const result = spawnSync(process.execPath, [join(repoRoot, "bin/adaegg.mjs"), "--help"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("init");
  });
});
