import { z } from "zod";
import { currentBranch, GitError, git, isClean } from "./git.ts";
import { defineNode } from "./types.ts";

// Rule for "already merged": every commit of the branch is on base
// (`base..branch` is empty) AND a merge commit on base's first-parent history
// has the branch tip as its second parent. A branch that never got commits of
// its own has no such merge commit, so it is not mistaken for merged.
function findMergeCommit(root: string, base: string, tip: string): string | null {
  if (Number(git(root, "rev-list", "--count", `${base}..${tip}`)) !== 0) return null;
  const log = git(root, "log", "--merges", "--first-parent", "--format=%H %P", base);
  for (const line of log.split("\n")) {
    const [hash, , second] = line.split(" ");
    if (hash && second === tip) return hash;
  }
  return null;
}

export const mergeNode = defineNode({
  type: "merge",
  outcomes: ["merged", "moved", "conflict", "blocked"],
  configSchema: z.object({}),
  async run(ctx) {
    const { branch, base, worktree } = ctx.state;
    if (!branch || !base || !worktree) {
      return { outcome: "blocked", problem: "no branch, base or worktree in the run state" };
    }
    const root = ctx.paths.root;
    const id8 = ctx.workItem.id.slice(0, 8);

    const tip = git(root, "rev-parse", branch);
    const done = findMergeCommit(root, base, tip);
    if (done) return { outcome: "merged", state: { mergeCommit: done, conflictFiles: [] } };

    const current = currentBranch(root);
    if (current !== base) {
      return {
        outcome: "blocked",
        problem: `the main checkout is on '${current}', not '${base}': check out '${base}' in ${root}`,
      };
    }
    if (!isClean(root)) {
      return {
        outcome: "blocked",
        problem: `the main checkout has uncommitted changes: commit or stash them in ${root}`,
      };
    }

    // Bring base into the branch first, so the checks run on what will land.
    if (Number(git(root, "rev-list", "--count", `${branch}..${base}`)) > 0) {
      try {
        git(worktree, "merge", "--no-edit", base);
      } catch {
        const conflictFiles = git(worktree, "diff", "--name-only", "--diff-filter=U")
          .split("\n")
          .filter((f) => f !== "");
        try {
          git(worktree, "merge", "--abort");
        } catch {
          // nothing to abort
        }
        return { outcome: "conflict", problem: `merge of ${base} conflicts`, state: { conflictFiles } };
      }
      return { outcome: "moved", state: { conflictFiles: [] } };
    }

    const before = git(root, "rev-parse", "HEAD");
    try {
      git(root, "merge", "--no-ff", "-m", `hatch: ${ctx.workItem.title} (${id8})`, branch);
    } catch (err) {
      try {
        git(root, "merge", "--abort");
      } catch {
        // ignore
      }
      const detail = err instanceof GitError ? err.stderr : String(err);
      return { outcome: "blocked", problem: `merging ${branch} into ${base} failed: ${detail}` };
    }
    const mergeCommit = git(root, "rev-parse", "HEAD");
    if (mergeCommit === before) {
      return { outcome: "blocked", problem: `${branch} has no commits of its own to merge` };
    }
    const changedPaths = git(root, "diff", "--name-only", `${mergeCommit}^1`, mergeCommit)
      .split("\n")
      .filter((f) => f !== "");
    return { outcome: "merged", state: { mergeCommit, changedPaths, conflictFiles: [] } };
  },
});
