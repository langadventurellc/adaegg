import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { branchExists, branchStart, getBranchConfig, git, setBranchConfig, shell, slugify, tail } from "./git.ts";
import { defineNode } from "./types.ts";

export const branchNode = defineNode({
  type: "branch",
  outcomes: ["ok", "fail"],
  configSchema: z.object({}),
  async run(ctx) {
    const id8 = ctx.workItem.id.slice(0, 8);
    const branch = `hatch/${id8}-${slugify(ctx.workItem.title)}`;
    const worktree = join(ctx.paths.stateDir, "worktrees", id8);
    const base = ctx.appConfig.baseBranch;

    // A retried item continues earlier work, so existing pieces are reused.
    if (!existsSync(worktree)) {
      if (branchExists(ctx.paths.root, branch)) {
        git(ctx.paths.root, "worktree", "add", worktree, branch);
      } else {
        // Remember where the branch started, so the merge node can tell a
        // branch with commits of its own from one that never got any.
        const start = git(ctx.paths.root, "rev-parse", base);
        git(ctx.paths.root, "worktree", "add", "-b", branch, worktree, base);
        setBranchConfig(ctx.paths.root, branch, "hatchStart", start);
      }
    }
    if (getBranchConfig(ctx.paths.root, branch, "hatchStart") === null) {
      setBranchConfig(ctx.paths.root, branch, "hatchStart", branchStart(ctx.paths.root, branch, base));
    }

    if (ctx.appConfig.setup !== "") {
      const result = await shell(worktree, ctx.appConfig.setup, {
        timeoutMs: ctx.appConfig.checksTimeoutMinutes * 60_000,
        signal: ctx.signal,
      });
      if (!result.ok) return { outcome: "fail", problem: tail(result.output) };
    }
    return { outcome: "ok", state: { base, branch, worktree } };
  },
});
