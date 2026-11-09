import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A machine whose global git config signs every commit with a signer that always fails.
function signingEnv(): NodeJS.ProcessEnv {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "adaegg-sign-")));
  dirs.push(home);
  const globalFile = join(home, "gitconfig");
  writeFileSync(
    globalFile,
    "[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalFile,
  };
  // The test setup file sets these in this process; the child must start without them.
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_CONFIG_") && /COUNT|KEY_|VALUE_/.test(key)) delete env[key];
  return env;
}

describe("hatchling tests under a global commit.gpgsign=true", () => {
  it("the fixture really breaks unprotected commits", () => {
    const env = signingEnv();
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "adaegg-sign-repo-")));
    dirs.push(repo);
    execFileSync("git", ["init"], { cwd: repo, env, stdio: "ignore" });
    const commit = spawnSync("git", ["commit", "--allow-empty", "-m", "x"], { cwd: repo, env, stdio: "ignore" });
    expect(commit.status).not.toBe(0);
  });

  it("still pass their real-git tests", { timeout: 120_000 }, () => {
    const run = spawnSync(
      join(root, "node_modules", ".bin", "vitest"),
      ["run", "hatchling/src/engine/nodes/merge.test.ts", "hatchling/src/engine/nodes/branch.test.ts"],
      { cwd: root, env: signingEnv(), encoding: "utf8", input: "" },
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  });
});
