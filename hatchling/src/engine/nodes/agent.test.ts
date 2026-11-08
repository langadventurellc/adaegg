import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AUTH_PROBLEM, buildPrompt, createAgentNode, createReviewNode, type QueryFn } from "./agent.ts";
import { buildTemplateRepo, copyRepo, makeCtx, makeWorkItem, removeAllRepos, removeCopies, sh } from "./test-repo.ts";
import { type RunState, RunStateSchema } from "./types.ts";

let template: string;
beforeAll(() => {
  template = buildTemplateRepo();
});
afterEach(removeCopies);
afterAll(removeAllRepos);

type Captured = { prompt?: string; options?: Record<string, unknown> };
type Msg = Record<string, unknown>;

const usage = { input_tokens: 120, output_tokens: 34 };
const success = (extra: Msg = {}): Msg => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "all done",
  total_cost_usd: 0.42,
  usage,
  ...extra,
});

// A fake `query`: records its arguments and yields the canned messages (running `during` first).
function fake(messages: Msg[], captured: Captured = {}, during?: () => void): QueryFn {
  return ((params: { prompt: string; options: Record<string, unknown> }) => {
    captured.prompt = params.prompt;
    captured.options = params.options;
    return (async function* () {
      during?.();
      for (const m of messages) yield m;
    })();
  }) as unknown as QueryFn;
}

function setup(over: { state?: Partial<RunState> } = {}) {
  const root = copyRepo(template);
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "implement.md"), "You are the implementer.\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-m", "add prompt");
  const ctx = makeCtx(root, { state: { worktree: root, branch: "main", base: "main", ...over.state } });
  return { root, ctx };
}

const agentConfig = {
  prompt: "prompts/implement.md",
  model: "implement",
  tools: ["Read", "Edit"],
  bash: ["npm *", "git *"],
  deny: ["Bash(git push*)"],
  maxTurns: 10,
  maxBudgetUsd: 2,
};

function parse(node: { configSchema: { parse(v: unknown): unknown } }, config: object): unknown {
  return node.configSchema.parse(config);
}

async function runAgent(
  ctx: ReturnType<typeof makeCtx>,
  query: QueryFn,
  config: object = agentConfig,
  node = createAgentNode({ query }),
) {
  return node.run({ ...ctx, config: parse(node, config) } as never);
}

describe("buildPrompt", () => {
  const item = makeWorkItem({ title: "Add it", contents: "Do the thing." });
  const state = RunStateSchema.parse({});

  it("has the role, then the work item, and nothing else when the state is empty", () => {
    const text = buildPrompt("Role text\n", item, state);
    expect(text).toBe("Role text\n\n# Work item: Add it\n\nWork item id: abcdef1234567890\n\nDo the thing.\n");
  });

  it("names the base branch when the run has one", () => {
    const text = buildPrompt("Role", item, RunStateSchema.parse({ base: "main" }));
    expect(text).toContain("Work item id: abcdef1234567890\nBase branch: main\n\nDo the thing.");
  });

  it("adds check output, findings and conflicts in that order", () => {
    const text = buildPrompt(
      "Role",
      item,
      RunStateSchema.parse({ checkOutput: "lint failed", findings: ["a", "b"], conflictFiles: ["x.ts"] }),
    );
    expect(text).toContain("# Check output\n\nlint failed");
    expect(text).toContain("# Review findings\n\n- a\n- b");
    expect(text).toContain("# Merge conflicts\n\n- x.ts");
    expect(text.indexOf("Work item")).toBeLessThan(text.indexOf("Check output"));
    expect(text.indexOf("Check output")).toBeLessThan(text.indexOf("Review findings"));
    expect(text.indexOf("Review findings")).toBeLessThan(text.indexOf("Merge conflicts"));
  });
});

describe("agent node options", () => {
  it("builds the SDK options from the config", async () => {
    const { root, ctx } = setup();
    const captured: Captured = {};
    process.env.ADAEGG_TEST_SENTINEL = "kept";
    const before = { ...process.env };
    try {
      const result = await runAgent(ctx, fake([success()], captured));
      expect(result.outcome).toBe("done");
      const o = captured.options as Record<string, unknown>;
      expect(captured.prompt).toContain("You are the implementer.");
      expect(captured.prompt).toContain("# Work item: Add the thing");
      expect(o.cwd).toBe(root);
      expect(o.allowedTools).toEqual(["Read", "Edit", "Bash(npm *)", "Bash(git *)"]);
      expect(o.disallowedTools).toEqual(["Bash(git push*)"]);
      // Unlisted tools are denied, never prompted, and nothing is bypassed.
      expect(o.permissionMode).toBe("dontAsk");
      expect(o.model).toBe("sonnet");
      expect(o.maxTurns).toBe(10);
      expect(o.maxBudgetUsd).toBe(2);
      expect(o.settingSources).toEqual(["project"]);
      expect(o.abortController).toBeInstanceOf(AbortController);
      expect(o.outputFormat).toBeUndefined();

      const env = o.env as Record<string, string>;
      expect(env.ADAEGG_TEST_SENTINEL).toBe("kept");
      expect(env.ADAEGG_STATE_DIR).toBe(join(root, ".adaegg"));
      const expected = { ...before, ADAEGG_STATE_DIR: join(root, ".adaegg") };
      expect(env).toEqual(expected);
    } finally {
      delete process.env.ADAEGG_TEST_SENTINEL;
    }
  });

  it("looks the model alias up in appConfig.models", async () => {
    const { ctx } = setup();
    const captured: Captured = {};
    const withModels = { ...ctx, appConfig: { ...ctx.appConfig, models: { implement: "opus", review: "haiku" } } };
    await runAgent(withModels, fake([success()], captured));
    expect(captured.options?.model).toBe("opus");
  });

  it("aborts the SDK's controller when the run's signal aborts", async () => {
    const { ctx } = setup();
    const controller = new AbortController();
    const captured: Captured = {};
    const query = fake([success()], captured, () => controller.abort(new Error("shutdown")));
    await expect(runAgent({ ...ctx, signal: controller.signal }, query)).rejects.toThrow("shutdown");
    const sdkController = captured.options?.abortController as AbortController;
    expect(sdkController.signal.aborted).toBe(true);
  });

  it("is blocked without a worktree", async () => {
    const { ctx } = setup({ state: { worktree: null } });
    const result = await runAgent(ctx, fake([success()]));
    expect(result.outcome).toBe("blocked");
  });

  it("rejects a prompt outside prompts/", async () => {
    const { root, ctx } = setup();
    writeFileSync(join(root, "secret.md"), "x");
    for (const prompt of ["prompts/../secret.md", "../secret.md", "/etc/passwd", "secret.md"]) {
      const result = await runAgent(ctx, fake([success()]), { ...agentConfig, prompt });
      expect(result.outcome, prompt).toBe("blocked");
    }
  });

  it("rejects a model that is not implement or review", () => {
    const node = createAgentNode({ query: fake([]) });
    expect(() => parse(node, { ...agentConfig, model: "gpt" })).toThrow();
  });
});

describe("agent node results", () => {
  it("records cost and tokens on success", async () => {
    const { ctx } = setup();
    const result = await runAgent(ctx, fake([success()]));
    expect(result).toMatchObject({ outcome: "done", costUsd: 0.42, tokens: { input: 120, output: 34 } });
  });

  it.each(["error_max_turns", "error_max_budget_usd"])("%s gives failed with the errors", async (subtype) => {
    const { ctx } = setup();
    const result = await runAgent(
      ctx,
      fake([{ type: "result", subtype, is_error: true, errors: ["too much"], total_cost_usd: 1, usage }]),
    );
    expect(result.outcome).toBe("failed");
    expect(result.problem).toBe(`${subtype}: too much`);
    expect(result.costUsd).toBe(1);
  });

  it("gives failed when the stream ends without a result", async () => {
    const { ctx } = setup();
    expect((await runAgent(ctx, fake([]))).outcome).toBe("failed");
  });

  it("gives blocked with the guidance on an authentication error", async () => {
    const { ctx } = setup();
    const result = await runAgent(
      ctx,
      fake([
        { type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "no" }] } },
        success({ is_error: true, result: "Invalid API key" }),
      ]),
    );
    expect(result.outcome).toBe("blocked");
    expect(result.problem).toBe(
      "Claude isn't signed in. Run `claude` once to log in, or set ANTHROPIC_API_KEY, then `hatch retry` this item.",
    );
    expect(AUTH_PROBLEM).toBe(result.problem);
  });

  it("gives blocked when only the result reports the login problem", async () => {
    const { ctx } = setup();
    const result = await runAgent(
      ctx,
      fake([success({ is_error: true, result: "Not logged in. Please authenticate" })]),
    );
    expect(result.problem).toBe(AUTH_PROBLEM);
  });

  it("gives blocked when the login problem is in the result's errors", async () => {
    const { ctx } = setup();
    const result = await runAgent(
      ctx,
      fake([
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Not logged in"],
          total_cost_usd: 0.05,
          usage,
        },
      ]),
    );
    expect(result).toMatchObject({
      outcome: "blocked",
      problem: AUTH_PROBLEM,
      costUsd: 0.05,
      tokens: { input: 120, output: 34 },
    });
  });

  // The SDK rejects after its messages when the Claude process exits nonzero.
  const rejecting = (messages: Msg[]) =>
    (() =>
      (async function* () {
        for (const m of messages) yield m;
        throw new Error("Claude Code process exited with code 1");
      })()) as unknown as QueryFn;

  it("keeps the guidance when an assistant auth error is followed by a rejection", async () => {
    const { ctx } = setup();
    const result = await runAgent(
      ctx,
      rejecting([{ type: "assistant", error: "authentication_failed", message: { content: [] } }]),
    );
    expect(result).toMatchObject({ outcome: "blocked", problem: AUTH_PROBLEM });
  });

  it("keeps the guidance and cost when an auth result is followed by a rejection", async () => {
    const { ctx } = setup();
    const result = await runAgent(
      ctx,
      rejecting([success({ is_error: true, result: "Not logged in. Please authenticate" })]),
    );
    expect(result).toMatchObject({ outcome: "blocked", problem: AUTH_PROBLEM, costUsd: 0.42 });
  });

  it.each(["error_max_turns", "error_max_budget_usd"])(
    "keeps the %s subtype and cost when a rejection follows",
    async (subtype) => {
      const { ctx } = setup();
      const result = await runAgent(
        ctx,
        rejecting([{ type: "result", subtype, is_error: true, errors: ["too much"], total_cost_usd: 1, usage }]),
      );
      expect(result).toMatchObject({
        outcome: "failed",
        problem: `${subtype}: too much`,
        costUsd: 1,
        tokens: { input: 120, output: 34 },
      });
    },
  );

  it("still throws a rejection that no result explains", async () => {
    const { ctx } = setup();
    await expect(runAgent(ctx, rejecting([]))).rejects.toThrow("exited with code 1");
  });

  it("throws the abort reason, not the rejection, when aborted", async () => {
    const { ctx } = setup();
    const controller = new AbortController();
    const query = (() =>
      (async function* () {
        controller.abort(new Error("stop"));
        yield { type: "assistant", message: { content: [] } };
        throw new Error("Claude Code process exited with code 1");
      })()) as unknown as QueryFn;
    await expect(runAgent({ ...ctx, signal: controller.signal }, query)).rejects.toThrow("stop");
  });

  it("stops reading when the signal aborts, and throws", async () => {
    const { ctx } = setup();
    const controller = new AbortController();
    let pulled = 0;
    const query = (() =>
      (async function* () {
        for (;;) {
          pulled++;
          if (pulled === 2) controller.abort(new Error("stop"));
          yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
        }
      })()) as unknown as QueryFn;
    await expect(runAgent({ ...ctx, signal: controller.signal }, query)).rejects.toThrow("stop");
    expect(pulled).toBeLessThan(5);
  });
});

describe("transcript", () => {
  it("writes one line per text, tool use and tool result, truncating long output", async () => {
    const { root, ctx } = setup();
    const long = "x".repeat(5000);
    await runAgent(
      { ...ctx, nodeId: "implement", attempt: 2 },
      fake([
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "looking" },
              { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
            ],
          },
        },
        { type: "user", message: { content: [{ type: "tool_result", content: long }] } },
        success(),
      ]),
    );
    const file = join(root, ".adaegg", "logs", ctx.runId.slice(0, 8), "implement-2.jsonl");
    const lines = readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ type: "text", text: "looking" });
    expect(lines[1]).toMatchObject({ type: "tool_use", name: "Read" });
    expect(lines[2].type).toBe("tool_result");
    expect(lines[2].output.length).toBeLessThan(2100);
    expect(lines[2].output.startsWith("x".repeat(2000))).toBe(true);
  });
});

describe("review node verdicts", () => {
  const reviewConfig = { ...agentConfig, model: "review", output: "text" };
  // The node under test must hold the fake that yields the messages.
  const run = async (messages: Msg[], captured?: Captured) => {
    const { ctx } = setup();
    const query = fake(messages, captured);
    const node = createReviewNode({ query });
    return node.run({ ...ctx, config: parse(node, reviewConfig) } as never);
  };

  it("has the verdict outcomes and forces verdict output", async () => {
    const node = createReviewNode({ query: fake([]) });
    expect(node.outcomes).toEqual(["approve", "changes", "failed", "blocked"]);
    expect(createAgentNode({ query: fake([]) }).outcomes).toEqual(["done", "failed", "blocked"]);
    expect((parse(node, reviewConfig) as { output: string }).output).toBe("verdict");
  });

  it("reads an approve from structured output and asks for the JSON schema", async () => {
    const captured: Captured = {};
    const result = await run([success({ structured_output: { verdict: "approve", findings: [] } })], captured);
    expect(result).toMatchObject({ outcome: "approve", state: { findings: [] } });
    expect(captured.options?.outputFormat).toMatchObject({ type: "json_schema" });
  });

  it("reads changes with findings", async () => {
    const result = await run([
      success({ structured_output: { verdict: "changes", findings: ["add a test", "fix x"] } }),
    ]);
    expect(result).toMatchObject({ outcome: "changes", state: { findings: ["add a test", "fix x"] } });
  });

  it("falls back to the last fenced json block", async () => {
    const text =
      'Draft:\n```json\n{"verdict":"approve","findings":[]}\n```\nFinal:\n```json\n{"verdict":"changes","findings":["no tests"]}\n```';
    const result = await run([success({ result: text })]);
    expect(result).toMatchObject({ outcome: "changes", state: { findings: ["no tests"] } });
  });

  it("fails on invalid JSON", async () => {
    const result = await run([success({ result: "```json\n{not json\n```" })]);
    expect(result).toMatchObject({ outcome: "failed", problem: "review gave no verdict" });
  });

  it("fails when there is no verdict at all", async () => {
    const result = await run([success({ result: "looks fine to me" })]);
    expect(result).toMatchObject({ outcome: "failed", problem: "review gave no verdict" });
  });

  it("fails on changes with no findings", async () => {
    const result = await run([success({ structured_output: { verdict: "changes", findings: [] } })]);
    expect(result).toMatchObject({ outcome: "failed", problem: "review gave no verdict" });
  });
});

describe("implement step guard", () => {
  function onBranch() {
    const { root, ctx } = setup();
    sh(root, "checkout", "-b", "hatch/abcdef12-add");
    return { root, ctx: { ...ctx, state: { ...ctx.state, branch: "hatch/abcdef12-add", base: "main" } } };
  }
  const config = { ...agentConfig, commit: true };

  it("commits a dirty worktree with the item's title and id", async () => {
    const { root, ctx } = onBranch();
    const query = fake([success()], {}, () => writeFileSync(join(root, "new.txt"), "hi\n"));
    const result = await runAgent(ctx, query, config);
    expect(result.outcome).toBe("done");
    expect(sh(root, "log", "-1", "--format=%s")).toBe("hatch: Add the thing (abcdef12)");
    expect(sh(root, "status", "--porcelain")).toBe("");
  });

  it("accepts work the agent committed itself", async () => {
    const { root, ctx } = onBranch();
    const query = fake([success()], {}, () => {
      writeFileSync(join(root, "own.txt"), "x\n");
      sh(root, "add", "-A");
      sh(root, "commit", "-m", "mine");
    });
    expect((await runAgent(ctx, query, config)).outcome).toBe("done");
    expect(sh(root, "log", "-1", "--format=%s")).toBe("mine");
  });

  it("fails when the branch has no commits of its own", async () => {
    const { ctx } = onBranch();
    const result = await runAgent(ctx, fake([success()]), config);
    expect(result).toMatchObject({ outcome: "failed", problem: "the implement step made no changes" });
  });

  it("fails when the agent only merges an advanced base into an untouched branch", async () => {
    const { root, ctx } = onBranch();
    const query = fake([success()], {}, () => {
      sh(root, "checkout", "-q", "main");
      writeFileSync(join(root, "other.txt"), "x\n");
      sh(root, "add", "-A");
      sh(root, "commit", "-m", "base moves");
      sh(root, "checkout", "-q", "hatch/abcdef12-add");
      sh(root, "merge", "--no-ff", "--no-edit", "main");
    });
    const result = await runAgent(ctx, query, config);
    expect(result).toMatchObject({ outcome: "failed", problem: "the implement step made no changes" });
  });

  it("fails when the branch's commits are already in base", async () => {
    const { root, ctx } = onBranch();
    const query = fake([success()], {}, () => {
      writeFileSync(join(root, "own.txt"), "x\n");
      sh(root, "add", "-A");
      sh(root, "commit", "-m", "mine");
      sh(root, "branch", "-f", "main", "HEAD");
    });
    const result = await runAgent(ctx, query, config);
    expect(result).toMatchObject({ outcome: "failed", problem: "the implement step made no changes" });
  });

  it("is safe to run twice", async () => {
    const { root, ctx } = onBranch();
    const query = fake([success()], {}, () => writeFileSync(join(root, "new.txt"), "hi\n"));
    await runAgent(ctx, query, config);
    const count = sh(root, "rev-list", "--count", "main..HEAD");
    const again = await runAgent(ctx, fake([success()]), config);
    expect(again.outcome).toBe("done");
    expect(sh(root, "rev-list", "--count", "main..HEAD")).toBe(count);
  });

  it("does nothing to the worktree when commit is off", async () => {
    const { root, ctx } = onBranch();
    const query = fake([success()], {}, () => writeFileSync(join(root, "new.txt"), "hi\n"));
    expect((await runAgent(ctx, query)).outcome).toBe("done");
    expect(sh(root, "status", "--porcelain")).toContain("new.txt");
  });
});
