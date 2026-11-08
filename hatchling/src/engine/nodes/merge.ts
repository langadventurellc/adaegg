import { z } from "zod";
import {
  branchStart,
  currentBranch,
  GitError,
  getBranchConfig,
  git,
  isAncestor,
  isClean,
  setBranchConfig,
} from "./git.ts";
import { defineNode } from "./types.ts";

function lines(text: string): string[] {
  return text.split("\n").filter((f) => f !== "");
}

// The commit on base's first-parent history that first contains `tip`: `tip`
// itself when base fast-forwarded to it, else the merge commit (of this or of
// another branch) that brought it in. Containment only grows along the chain,
// so walking from base back stops at the first commit that lacks `tip`.
function incorporatingCommit(root: string, base: string, tip: string): string {
  let found = tip;
  for (const commit of lines(git(root, "rev-list", "--first-parent", base))) {
    if (commit === tip) return tip;
    if (!isAncestor(root, tip, commit)) break;
    found = commit;
  }
  return found;
}

// "Already merged": the branch has commits of its own (its tip is not where it
// started) and every one of them is on base. How they got there does not matter.
function findMergeCommit(
  root: string,
  base: string,
  branch: string,
  tip: string,
): { mergeCommit: string; changedPaths: string[] } | null {
  if (!isAncestor(root, tip, base)) return null;
  const start = git(root, "rev-parse", branchStart(root, branch, base));
  if (tip === start) return null;
  const mergeCommit = incorporatingCommit(root, base, tip);
  const parents = git(root, "rev-list", "--parents", "-n", "1", mergeCommit).split(" ");
  const own = parents.length === 3 && parents[2] === tip;
  const changedPaths = lines(
    own
      ? git(root, "diff", "--name-only", `${mergeCommit}^1`, mergeCommit)
      : git(root, "diff", "--name-only", start, tip),
  );
  return { mergeCommit, changedPaths };
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

    // Finish a fast-forward whose hatchStart update a crash cut off, before
    // anything decides whether the branch has commits of its own.
    const pending = getBranchConfig(root, branch, "hatchStartPending");
    if (pending !== null) {
      if (tip === pending) setBranchConfig(root, branch, "hatchStart", tip);
      setBranchConfig(root, branch, "hatchStartPending", null);
    }

    const done = findMergeCommit(root, base, branch, tip);
    if (done) return { outcome: "merged", state: { ...done, conflictFiles: [] } };

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
      // Written before the merge, so a crash right after it is still noticed.
      setBranchConfig(root, branch, "hatchMovedFrom", tip);
      const start = git(root, "rev-parse", branchStart(root, branch, base));
      // A branch with no commits of its own will fast-forward to base; note where
      // before merging so a crash before hatchStart moves is recovered on resume.
      if (tip === start) setBranchConfig(root, branch, "hatchStartPending", git(root, "rev-parse", base));
      try {
        git(worktree, "merge", "--no-edit", base);
      } catch {
        const conflictFiles = lines(git(worktree, "diff", "--name-only", "--diff-filter=U"));
        try {
          git(worktree, "merge", "--abort");
        } catch {
          // nothing to abort
        }
        setBranchConfig(root, branch, "hatchMovedFrom", null);
        setBranchConfig(root, branch, "hatchStartPending", null);
        return { outcome: "conflict", problem: `merge of ${base} conflicts`, state: { conflictFiles } };
      }
      // A branch without commits of its own just fast-forwarded; it still has none.
      if (tip === start) setBranchConfig(root, branch, "hatchStart", git(worktree, "rev-parse", "HEAD"));
      setBranchConfig(root, branch, "hatchStartPending", null);
      return { outcome: "moved", state: { conflictFiles: [] } };
    }

    // Base was merged into the branch earlier (possibly just before a crash):
    // the checks must have passed on that combined tip before it lands.
    const movedFrom = getBranchConfig(root, branch, "hatchMovedFrom");
    if (movedFrom !== null && movedFrom !== tip && ctx.state.checkedCommit !== tip) {
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
    const changedPaths = lines(git(root, "diff", "--name-only", `${mergeCommit}^1`, mergeCommit));
    return { outcome: "merged", state: { mergeCommit, changedPaths, conflictFiles: [] } };
  },
});
