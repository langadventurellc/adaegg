import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { WorkItem } from "../store.ts";
import { branchStart, commitAll, git } from "./git.ts";
import { defineNode, type NodeContext, type NodeResult, type RunState } from "./types.ts";

export type QueryFn = typeof sdkQuery;

export const AUTH_PROBLEM =
  "Claude isn't signed in. Run `claude` once to log in, or set ANTHROPIC_API_KEY, then `hatch retry` this item.";

const TOOL_OUTPUT_LIMIT = 2000;

const AgentConfigSchema = z.object({
  // Relative to the repo root, and inside `prompts/`.
  prompt: z.string().min(1),
  model: z.enum(["implement", "review"]),
  tools: z.array(z.string()).default([]),
  bash: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  output: z.enum(["text", "verdict"]).default("text"),
  // The implement step guard: commit what the agent left and require a change.
  commit: z.boolean().default(false),
});

type AgentConfig = z.infer<typeof AgentConfigSchema>;

const VerdictSchema = z
  .object({
    verdict: z.enum(["approve", "changes"]),
    findings: z.array(z.string()).default([]),
  })
  .refine((v) => v.verdict === "approve" || v.findings.length > 0, {
    message: "changes needs at least one finding",
  });

const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "changes"] },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "findings"],
  additionalProperties: false,
};

// The role text, then the work item, then whatever the run state says needs fixing.
export function buildPrompt(promptText: string, workItem: WorkItem, state: RunState): string {
  const facts = [`Work item id: ${workItem.id}`, ...(state.base ? [`Base branch: ${state.base}`] : [])];
  const parts = [
    promptText.trim(),
    `# Work item: ${workItem.title}\n\n${facts.join("\n")}\n\n${workItem.contents}`.trimEnd(),
  ];
  if (state.checkOutput !== "") parts.push(`# Check output\n\n${state.checkOutput}`);
  if (state.findings.length > 0) {
    parts.push(`# Review findings\n\n${state.findings.map((f) => `- ${f}`).join("\n")}`);
  }
  if (state.conflictFiles.length > 0) {
    parts.push(`# Merge conflicts\n\n${state.conflictFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  return `${parts.join("\n\n")}\n`;
}

function promptPath(root: string, prompt: string): string | null {
  const dir = resolve(root, "prompts");
  const file = resolve(dir, "..", prompt);
  const rel = relative(dir, file);
  if (isAbsolute(prompt) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return file;
}

function truncate(text: string): string {
  return text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}… [truncated]` : text;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
      .join("");
  }
  return JSON.stringify(content ?? "");
}

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown };

// One transcript line per assistant text, tool use and tool result.
function transcriptLines(message: { type: string; message?: { content?: unknown } }): object[] {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  const lines: object[] = [];
  for (const block of content as Block[]) {
    if (message.type === "assistant" && block.type === "text") {
      lines.push({ type: "text", text: block.text ?? "" });
    } else if (message.type === "assistant" && block.type === "tool_use") {
      lines.push({ type: "tool_use", name: block.name, input: truncate(JSON.stringify(block.input ?? {})) });
    } else if (message.type === "user" && block.type === "tool_result") {
      lines.push({ type: "tool_result", output: truncate(textOf(block.content)) });
    }
  }
  return lines;
}

function lastJsonBlock(text: string): unknown {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

function readVerdict(structured: unknown, text: string) {
  const parsed = VerdictSchema.safeParse(structured ?? lastJsonBlock(text));
  return parsed.success ? parsed.data : null;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

// Commits what the agent left and fails the step when the branch still has nothing of its own.
function implementGuard(ctx: NodeContext<AgentConfig>, worktree: string): NodeResult | null {
  const { branch, base } = ctx.state;
  const id8 = ctx.workItem.id.slice(0, 8);
  commitAll(worktree, `hatch: ${ctx.workItem.title} (${id8})`);
  if (!branch || !base) return { outcome: "blocked", problem: "no branch or base in the run state" };
  const tip = git(worktree, "rev-parse", "HEAD");
  const start = git(ctx.paths.root, "rev-parse", branchStart(ctx.paths.root, branch, base));
  if (tip === start) return { outcome: "failed", problem: "the implement step made no changes" };
  return null;
}

function createNode(type: "agent" | "review", query: QueryFn) {
  const verdictType = type === "review";
  return defineNode<AgentConfig>({
    type,
    outcomes: verdictType ? ["approve", "changes", "failed", "blocked"] : ["done", "failed", "blocked"],
    configSchema: verdictType
      ? AgentConfigSchema.transform((c) => ({ ...c, output: "verdict" as const }))
      : AgentConfigSchema,
    async run(ctx): Promise<NodeResult> {
      const { config } = ctx;
      const worktree = ctx.state.worktree;
      if (!worktree) return { outcome: "blocked", problem: "no worktree in the run state" };
      const file = promptPath(ctx.paths.root, config.prompt);
      if (!file) return { outcome: "blocked", problem: `prompt ${config.prompt} is not inside prompts/` };
      let promptText: string;
      try {
        promptText = readFileSync(file, "utf8");
      } catch {
        return { outcome: "blocked", problem: `cannot read prompt ${config.prompt}` };
      }
      const verdict = config.output === "verdict";
      if (ctx.signal.aborted) throw abortError(ctx.signal);

      const abortController = new AbortController();
      const onAbort = () => abortController.abort(ctx.signal.reason);
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const transcript = join(ctx.paths.stateDir, "logs", ctx.runId.slice(0, 8), `${ctx.nodeId}-${ctx.attempt}.jsonl`);
      mkdirSync(dirname(transcript), { recursive: true });

      let authFailed = false;
      let result: Record<string, unknown> | null = null;
      try {
        const stream = query({
          prompt: buildPrompt(promptText, ctx.workItem, ctx.state),
          options: {
            cwd: worktree,
            allowedTools: [...config.tools, ...config.bash.map((p) => `Bash(${p})`)],
            disallowedTools: config.deny,
            // Tools outside allowedTools are denied: nobody is there to answer a prompt.
            permissionMode: "dontAsk",
            model: ctx.appConfig.models[config.model],
            ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
            ...(config.maxBudgetUsd !== undefined ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
            settingSources: ["project"],
            abortController,
            env: { ...process.env, ADAEGG_STATE_DIR: resolve(ctx.paths.stateDir) },
            ...(verdict ? { outputFormat: { type: "json_schema" as const, schema: VERDICT_JSON_SCHEMA } } : {}),
          },
        });
        for await (const message of stream) {
          if (ctx.signal.aborted) throw abortError(ctx.signal);
          for (const line of transcriptLines(message as never)) {
            appendFileSync(transcript, `${JSON.stringify(line)}\n`);
          }
          if (message.type === "assistant" && message.error === "authentication_failed") authFailed = true;
          if (message.type === "result") result = message as unknown as Record<string, unknown>;
        }
      } catch (err) {
        if (ctx.signal.aborted) throw abortError(ctx.signal);
        throw err;
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      if (ctx.signal.aborted) throw abortError(ctx.signal);

      const usage = (result?.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      const spent: Pick<NodeResult, "costUsd" | "tokens"> = result
        ? {
            costUsd: Number(result.total_cost_usd ?? 0),
            tokens: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 },
          }
        : {};
      const resultText = typeof result?.result === "string" ? result.result : "";

      if (authFailed || (result?.is_error === true && /authenticat|not logged in|invalid api key/i.test(resultText))) {
        return { outcome: "blocked", problem: AUTH_PROBLEM, ...spent };
      }
      if (!result) return { outcome: "failed", problem: "the agent ended without a result" };
      if (result.subtype !== "success") {
        const errors = Array.isArray(result.errors) ? result.errors.join("; ") : "";
        return {
          outcome: "failed",
          problem: errors ? `${result.subtype}: ${errors}` : String(result.subtype),
          ...spent,
        };
      }

      if (verdict) {
        const parsed = readVerdict(result.structured_output, resultText);
        if (!parsed) return { outcome: "failed", problem: "review gave no verdict", ...spent };
        return parsed.verdict === "approve"
          ? { outcome: "approve", state: { findings: [] }, ...spent }
          : { outcome: "changes", state: { findings: parsed.findings }, ...spent };
      }

      if (config.commit) {
        const failed = implementGuard(ctx, worktree);
        if (failed) return { ...failed, ...spent };
      }
      return { outcome: "done", ...spent };
    },
  });
}

export function createAgentNode({ query }: { query: QueryFn }) {
  return createNode("agent", query);
}

// The same implementation with the verdict outcomes; its config forces `output: verdict`.
export function createReviewNode({ query }: { query: QueryFn }) {
  return createNode("review", query);
}
