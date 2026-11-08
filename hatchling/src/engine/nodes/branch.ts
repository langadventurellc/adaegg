import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { branchExists, git, shellSync, slugify, tail } from "./git.ts";
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
        git(ctx.paths.root, "worktree", "add", "-b", branch, worktree, base);
      }
    }

    if (ctx.appConfig.setup !== "") {
      const result = shellSync(worktree, ctx.appConfig.setup);
      if (!result.ok) return { outcome: "fail", problem: tail(result.output) };
    }
    return { outcome: "ok", state: { base, branch, worktree } };
  },
});
