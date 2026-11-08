import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { branchNode } from "./branch.ts";
import { mergeNode } from "./merge.ts";
import { buildTemplateRepo, copyRepo, makeCtx, removeAllRepos, removeCopies, sh } from "./test-repo.ts";
import type { RunState } from "./types.ts";

let template: string;
beforeAll(() => {
  template = buildTemplateRepo();
});
afterEach(removeCopies);
afterAll(removeAllRepos);

async function setup(): Promise<{ root: string; state: Partial<RunState> }> {
  const root = copyRepo(template);
  const result = await branchNode.run(makeCtx(root));
  return { root, state: result.state ?? {} };
}

function commitFile(dir: string, name: string, content: string) {
  writeFileSync(join(dir, name), content);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-m", `add ${name}`);
}

describe("merge node", () => {
  it("merges the branch into main", async () => {
    const { root, state } = await setup();
    commitFile(state.worktree ?? "", "feature.txt", "x\n");
    const result = await mergeNode.run(makeCtx(root, { state }));
    expect(result.outcome).toBe("merged");
    expect(existsSync(join(root, "feature.txt"))).toBe(true);
    expect(result.state?.mergeCommit).toBe(sh(root, "rev-parse", "HEAD"));
    expect(sh(root, "log", "-1", "--format=%s")).toBe("hatch: Add the thing (abcdef12)");
  });

  it("changedPaths is exactly the files the branch changed", async () => {
    const { root, state } = await setup();
    commitFile(state.worktree ?? "", "a.txt", "a\n");
    commitFile(state.worktree ?? "", "b.txt", "b\n");
    const result = await mergeNode.run(makeCtx(root, { state }));
    expect([...(result.state?.changedPaths ?? [])].sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("is idempotent", async () => {
    const { root, state } = await setup();
    commitFile(state.worktree ?? "", "feature.txt", "x\n");
    const first = await mergeNode.run(makeCtx(root, { state }));
    const second = await mergeNode.run(makeCtx(root, { state }));
    expect(second.outcome).toBe("merged");
    expect(second.state?.mergeCommit).toBe(first.state?.mergeCommit);
    expect(sh(root, "rev-list", "--count", "HEAD")).toBe("3");
  });

  it("returns moved when base advanced, then merged", async () => {
    const { root, state } = await setup();
    commitFile(state.worktree ?? "", "feature.txt", "x\n");
    commitFile(root, "other.txt", "o\n");
    const moved = await mergeNode.run(makeCtx(root, { state }));
    expect(moved.outcome).toBe("moved");
    expect(existsSync(join(state.worktree ?? "", "other.txt"))).toBe(true);
    const checkedCommit = sh(state.worktree ?? "", "rev-parse", "HEAD");
    const merged = await mergeNode.run(makeCtx(root, { state: { ...state, checkedCommit } }));
    expect(merged.outcome).toBe("merged");
    expect(merged.state?.changedPaths).toEqual(["feature.txt"]);
  });

  it("after a restart following moved, asks for the checks again before merging", async () => {
    const { root, state } = await setup();
    const wt = state.worktree ?? "";
    commitFile(wt, "feature.txt", "x\n");
    commitFile(root, "other.txt", "o\n");
    await mergeNode.run(makeCtx(root, { state }));
    // The run state was lost with the crash: checkedCommit still names no tip.
    const stale = await mergeNode.run(makeCtx(root, { state: { ...state, checkedCommit: "0".repeat(40) } }));
    expect(stale.outcome).toBe("moved");
    expect(existsSync(join(root, "feature.txt"))).toBe(false);
    const checkedCommit = sh(wt, "rev-parse", "HEAD");
    const merged = await mergeNode.run(makeCtx(root, { state: { ...state, checkedCommit } }));
    expect(merged.outcome).toBe("merged");
    expect(existsSync(join(root, "feature.txt"))).toBe(true);
  });

  it("recovers changedPaths when the merge landed before the state was saved", async () => {
    const { root, state } = await setup();
    commitFile(state.worktree ?? "", "a.txt", "a\n");
    commitFile(state.worktree ?? "", "b.txt", "b\n");
    const first = await mergeNode.run(makeCtx(root, { state }));
    const again = await mergeNode.run(makeCtx(root, { state }));
    expect(again.state?.mergeCommit).toBe(first.state?.mergeCommit);
    expect([...(again.state?.changedPaths ?? [])].sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("treats a branch fast-forwarded into base as merged", async () => {
    const { root, state } = await setup();
    commitFile(state.worktree ?? "", "feature.txt", "x\n");
    sh(root, "merge", "--ff-only", state.branch ?? "");
    const result = await mergeNode.run(makeCtx(root, { state }));
    expect(result.outcome).toBe("merged");
    expect(result.state?.mergeCommit).toBe(sh(root, "rev-parse", "HEAD"));
    expect(result.state?.changedPaths).toEqual(["feature.txt"]);
  });

  it("treats a branch incorporated through another merged branch as merged", async () => {
    const { root, state } = await setup();
    commitFile(state.worktree ?? "", "feature.txt", "x\n");
    sh(root, "checkout", "-b", "other", state.branch ?? "");
    commitFile(root, "extra.txt", "e\n");
    sh(root, "checkout", "main");
    commitFile(root, "mainline.txt", "m\n");
    sh(root, "merge", "--no-ff", "-m", "land other", "other");
    const result = await mergeNode.run(makeCtx(root, { state }));
    expect(result.outcome).toBe("merged");
    expect(result.state?.mergeCommit).toBe(sh(root, "rev-parse", "HEAD"));
    expect(result.state?.changedPaths).toEqual(["feature.txt"]);
  });

  it("does not call an untouched branch merged when base moved on", async () => {
    const { root, state } = await setup();
    commitFile(root, "other.txt", "o\n");
    const moved = await mergeNode.run(makeCtx(root, { state }));
    expect(moved.outcome).toBe("moved");
    const checkedCommit = sh(state.worktree ?? "", "rev-parse", "HEAD");
    const result = await mergeNode.run(makeCtx(root, { state: { ...state, checkedCommit } }));
    expect(result.outcome).toBe("blocked");
    expect(result.problem).toContain("no commits of its own");
  });

  describe("restart after an untouched branch fast-forwarded but before hatchStart moved", () => {
    async function crashed(advanceAgain: boolean) {
      const { root, state } = await setup();
      const wt = state.worktree ?? "";
      commitFile(root, "other.txt", "o\n");
      // What the node persisted before merging, then the fast-forward; the crash hit before hatchStart moved.
      sh(root, "config", `branch.${state.branch}.hatchStartPending`, sh(root, "rev-parse", "main"));
      sh(wt, "merge", "--ff-only", "main");
      if (advanceAgain) commitFile(root, "later.txt", "l\n");
      return { root, state };
    }

    it("is not reported as merged while base stays put", async () => {
      const { root, state } = await crashed(false);
      const result = await mergeNode.run(makeCtx(root, { state }));
      expect(result.outcome).toBe("blocked");
      expect(result.problem).toContain("no commits of its own");
    });

    it("is not reported as merged when base advanced again", async () => {
      const { root, state } = await crashed(true);
      const result = await mergeNode.run(makeCtx(root, { state }));
      expect(result.outcome).toBe("moved");
      const checkedCommit = sh(state.worktree ?? "", "rev-parse", "HEAD");
      const again = await mergeNode.run(makeCtx(root, { state: { ...state, checkedCommit } }));
      expect(again.outcome).toBe("blocked");
    });
  });

  it("returns conflict and leaves the worktree clean", async () => {
    const { root, state } = await setup();
    const wt = state.worktree ?? "";
    commitFile(wt, "README.md", "branch\n");
    commitFile(root, "README.md", "main\n");
    const result = await mergeNode.run(makeCtx(root, { state }));
    expect(result.outcome).toBe("conflict");
    expect(result.state?.conflictFiles).toEqual(["README.md"]);
    expect(sh(wt, "status", "--porcelain")).toBe("");
    const mergeHead = sh(wt, "rev-parse", "--git-path", "MERGE_HEAD");
    expect(existsSync(join(wt, mergeHead))).toBe(false);
  });

  it("is blocked by a dirty main checkout", async () => {
    const { root, state } = await setup();
    commitFile(state.worktree ?? "", "feature.txt", "x\n");
    writeFileSync(join(root, "README.md"), "dirty\n");
    const result = await mergeNode.run(makeCtx(root, { state }));
    expect(result.outcome).toBe("blocked");
    expect(result.problem).toContain("uncommitted changes");
  });

  it("is blocked when main is on another branch", async () => {
    const { root, state } = await setup();
    commitFile(state.worktree ?? "", "feature.txt", "x\n");
    sh(root, "checkout", "-b", "other");
    const result = await mergeNode.run(makeCtx(root, { state }));
    expect(result.outcome).toBe("blocked");
    expect(result.problem).toContain("'other'");
    expect(result.problem).toContain("'main'");
  });
});
