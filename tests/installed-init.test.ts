import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("init from an installed package", () => {
  it("loads the template's names with native Node when everything sits under node_modules", () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "adaegg-installed-")));
    const pkg = join(tmp, "node_modules", "adaegg");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    copyFileSync(join(repoRoot, "bin/adaegg.mjs"), join(pkg, "bin/adaegg.mjs"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "adaegg", type: "module" }));
    mkdirSync(join(pkg, "hatchling", "src"), { recursive: true });
    copyFileSync(join(repoRoot, "hatchling/adaegg.json"), join(pkg, "hatchling/adaegg.json"));
    cpSync(join(repoRoot, "hatchling/src/names"), join(pkg, "hatchling/src/names"), { recursive: true });

    const build = spawnSync(
      process.execPath,
      [
        join(repoRoot, "node_modules/typescript/bin/tsc"),
        "-p",
        join(repoRoot, "installer/tsconfig.build.json"),
        "--outDir",
        join(pkg, "dist/installer"),
      ],
      { encoding: "utf8" },
    );
    expect(build.stderr + build.stdout).toBe("");
    expect(build.status).toBe(0);

    const work = join(tmp, "work");
    mkdirSync(join(work, "full"), { recursive: true });
    writeFileSync(join(work, "full", "file"), "");

    const result = spawnSync(
      process.execPath,
      [join(pkg, "bin/adaegg.mjs"), "init", "--name", "Pip", "--dir", "full", "--no-start"],
      { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(result.stderr).toContain("is not empty; pick a new or empty folder.");
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
    expect(result.status).not.toBe(0);
  }, 60_000);
});
