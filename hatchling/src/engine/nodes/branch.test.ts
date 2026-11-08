import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { branchNode } from "./branch.ts";
import { buildTemplateRepo, copyRepo, makeCtx, sh } from "./test-repo.ts";

let template: string;
beforeAll(() => {
  template = buildTemplateRepo();
});

describe("branch node", () => {
  it("creates the branch and worktree", async () => {
    const root = copyRepo(template);
    const result = await branchNode.run(makeCtx(root));
    expect(result.outcome).toBe("ok");
    expect(result.state?.branch).toBe("hatch/abcdef12-add-the-thing");
    expect(result.state?.base).toBe("main");
    expect(result.state?.worktree).toBe(join(root, ".adaegg", "worktrees", "abcdef12"));
    expect(existsSync(join(result.state?.worktree ?? "", "README.md"))).toBe(true);
    expect(sh(root, "branch", "--list", "hatch/*")).toContain("hatch/abcdef12-add-the-thing");
  });

  it("reuses an existing branch and worktree", async () => {
    const root = copyRepo(template);
    const first = await branchNode.run(makeCtx(root));
    sh(first.state?.worktree ?? "", "commit", "--allow-empty", "-m", "earlier work");
    const tip = sh(root, "rev-parse", "hatch/abcdef12-add-the-thing");
    const second = await branchNode.run(makeCtx(root));
    expect(second.outcome).toBe("ok");
    expect(second.state).toEqual(first.state);
    expect(sh(root, "rev-parse", "hatch/abcdef12-add-the-thing")).toBe(tip);
  });

  it("recreates the worktree for an existing branch", async () => {
    const root = copyRepo(template);
    const first = await branchNode.run(makeCtx(root));
    sh(root, "worktree", "remove", "--force", first.state?.worktree ?? "");
    const second = await branchNode.run(makeCtx(root));
    expect(second.outcome).toBe("ok");
    expect(existsSync(second.state?.worktree ?? "")).toBe(true);
  });

  it("fails with the output tail when setup fails", async () => {
    const root = copyRepo(template);
    const result = await branchNode.run(makeCtx(root, { config: { setup: "echo setup broke; exit 1" } }));
    expect(result.outcome).toBe("fail");
    expect(result.problem).toContain("setup broke");
  });
});
