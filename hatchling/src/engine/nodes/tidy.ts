import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { currentBranch, git, isAncestor } from "./git.ts";
import { defineNode } from "./types.ts";

const DAY_MS = 86_400_000;

export const tidyNode = defineNode({
  type: "tidy",
  outcomes: ["tidied", "failed"],
  configSchema: z.object({ retainLogDays: z.number().int().positive().default(30) }),
  async run(ctx) {
    const { root, stateDir } = ctx.paths;
    const base = ctx.appConfig.baseBranch;
    const problems: string[] = [];
    let worktrees = 0;
    let branches = 0;
    let logDirs = 0;
    let skipped = 0;

    // Only merged work of done items goes; a failed item's worktree is how its retry continues.
    const done = ctx.db.prepare("SELECT id FROM work_items WHERE status = 'done'").all() as { id: string }[];
    for (const { id } of done) {
      const path = join(stateDir, "worktrees", id.slice(0, 8));
      if (!existsSync(path)) continue;
      try {
        const branch = currentBranch(path);
        if (!branch.startsWith("hatch/") || !isAncestor(root, branch, base)) {
          skipped++;
          continue;
        }
        git(root, "worktree", "remove", "--force", path);
        worktrees++;
        git(root, "branch", "-d", branch);
        branches++;
      } catch (err) {
        problems.push(`worktree ${id.slice(0, 8)}: ${(err as Error).message}`);
      }
    }
    try {
      git(root, "worktree", "prune");
    } catch (err) {
      problems.push(`worktree prune: ${(err as Error).message}`);
    }

    const logsDir = join(stateDir, "logs");
    if (existsSync(logsDir)) {
      const running = new Set(
        (ctx.db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as { id: string }[]).map((r) =>
          r.id.slice(0, 8),
        ),
      );
      const cutoff = ctx.now().getTime() - ctx.config.retainLogDays * DAY_MS;
      for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || running.has(entry.name)) continue;
        const dir = join(logsDir, entry.name);
        try {
          if (statSync(dir).mtimeMs >= cutoff) continue;
          rmSync(dir, { recursive: true, force: true });
          logDirs++;
        } catch (err) {
          problems.push(`logs ${entry.name}: ${(err as Error).message}`);
        }
      }
    }

    process.stdout.write(
      `tidy: removed ${worktrees} worktrees, ${branches} branches, ${logDirs} log directories (skipped ${skipped})\n`,
    );
    if (problems.length > 0) return { outcome: "failed", problem: problems.join("\n") };
    return { outcome: "tidied" };
  },
});
