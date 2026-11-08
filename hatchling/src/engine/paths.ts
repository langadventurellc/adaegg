import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function findRepoRoot(cwd: string): string {
  let dir = resolve(cwd);
  while (!existsSync(join(dir, "adaegg.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no adaegg.json found from ${cwd}`);
    dir = parent;
  }
  const git = join(dir, ".git");
  if (existsSync(git) && statSync(git).isFile()) {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, encoding: "utf8" }).trim();
    return dirname(resolve(dir, common));
  }
  return dir;
}

export function stateDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ADAEGG_STATE_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error(`ADAEGG_STATE_DIR must be an absolute path, got ${override}`);
    return override;
  }
  return join(root, ".adaegg");
}

export function dbPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(root, env), "hatch.db");
}
