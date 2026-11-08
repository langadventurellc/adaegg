import { beforeAll, describe, expect, it } from "vitest";
import { checksNode } from "./checks.ts";
import { buildTemplateRepo, copyRepo, makeCtx } from "./test-repo.ts";

let template: string;
beforeAll(() => {
  template = buildTemplateRepo();
});

function ctxWith(checks: string, extra: { checksTimeoutMinutes?: number; checkOutput?: string } = {}) {
  const root = copyRepo(template);
  return makeCtx(root, {
    config: { checks, checksTimeoutMinutes: extra.checksTimeoutMinutes ?? 1 },
    state: { worktree: root, checkOutput: extra.checkOutput ?? "" },
  });
}

describe("checks node", () => {
  it("passes and clears the output", async () => {
    const result = await checksNode.run(ctxWith("true", { checkOutput: "old" }));
    expect(result.outcome).toBe("passed");
    expect(result.state?.checkOutput).toBe("");
  });

  it("sets CI=1", async () => {
    const result = await checksNode.run(ctxWith('test "$CI" = 1'));
    expect(result.outcome).toBe("passed");
  });

  it("fails and keeps the output", async () => {
    const result = await checksNode.run(ctxWith("echo out; echo err >&2; exit 1"));
    expect(result.outcome).toBe("failed");
    expect(result.state?.checkOutput).toContain("out");
    expect(result.state?.checkOutput).toContain("err");
  });

  it("keeps only the last 200 lines", async () => {
    const result = await checksNode.run(ctxWith("seq 1 500; exit 1"));
    const lines = (result.state?.checkOutput ?? "").trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(lines.at(-1)).toBe("500");
    expect(lines).not.toContain("1");
  });

  it("fails on timeout with a note", async () => {
    const started = Date.now();
    const result = await checksNode.run(ctxWith("echo start; sleep 5", { checksTimeoutMinutes: 0.01 }));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.outcome).toBe("failed");
    expect(result.state?.checkOutput).toContain("start");
    expect(result.state?.checkOutput).toContain("checks timed out after 0.01 minutes");
  });

  it("throws when aborted", async () => {
    const controller = new AbortController();
    const root = copyRepo(template);
    const ctx = makeCtx(root, {
      config: { checks: "sleep 5" },
      state: { worktree: root },
      signal: controller.signal,
    });
    const running = checksNode.run(ctx);
    setTimeout(() => controller.abort(new Error("aborted")), 100);
    await expect(running).rejects.toThrow("aborted");
  });
});
