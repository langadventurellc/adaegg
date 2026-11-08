import { z } from "zod";
import { shell, tail } from "./git.ts";
import { defineNode } from "./types.ts";

export const checksNode = defineNode({
  type: "checks",
  outcomes: ["passed", "failed"],
  configSchema: z.object({}),
  async run(ctx) {
    const worktree = ctx.state.worktree;
    if (!worktree) return { outcome: "failed", problem: "no worktree in the run state" };
    const minutes = ctx.appConfig.checksTimeoutMinutes;
    const result = await shell(worktree, ctx.appConfig.checks, {
      env: { ...process.env, CI: "1" },
      timeoutMs: minutes * 60_000,
      signal: ctx.signal,
    });
    if (result.ok) return { outcome: "passed", state: { checkOutput: "" } };
    const timeoutLine = result.timedOut ? `checks timed out after ${minutes} minutes` : "";
    const checkOutput = tail(timeoutLine ? `${result.output}\n${timeoutLine}` : result.output);
    return {
      outcome: "failed",
      problem: timeoutLine || "checks failed",
      state: { checkOutput },
    };
  },
});
