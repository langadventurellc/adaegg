import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  type ChatContextMessage,
  chatContext,
  failChatTurn,
  finishChatTurn,
  INTERRUPTED_TEXT,
} from "../engine/chat.ts";
import type { Config } from "../engine/config.ts";
import { AUTH_PATTERN, lastJsonBlock, type QueryFn, transcriptLines } from "../engine/nodes/agent.ts";
import { listWorkItems } from "../engine/store.ts";
import { type Delivery, summarizeQueue } from "./queue.ts";

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const QUEUE_ROWS = 20;
const ERROR_CHARS = 300;
const ATTENTION_ERROR_CHARS = 800;
// The 10,000-character ask limit plus room for the decisions and assumptions the chat adds.
export const MAX_REQUEST_CONTENTS = 30_000;

export const CHAT_SIGNED_OUT =
  "Claude isn't signed in. Run `claude` once to log in, or set ANTHROPIC_API_KEY, then send your message again.";
export const CHAT_NO_REPLY = "I couldn't write a reply. Send your message again.";
export const CHAT_TIMED_OUT = "The reply took too long. Send your message again.";

export const CHAT_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git diff*)",
  "Bash(git status*)",
  "Bash(ls *)",
];

export const CHAT_JSON_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    request: {
      type: "object",
      properties: { title: { type: "string" }, contents: { type: "string" } },
      required: ["title", "contents"],
      additionalProperties: false,
    },
  },
  required: ["reply"],
  additionalProperties: false,
};

const ChatOutputSchema = z.object({
  reply: z.string().min(1),
  request: z.object({ title: z.string().min(1), contents: z.string().min(1).max(MAX_REQUEST_CONTENTS) }).optional(),
});

export type ChatRunner = { start(replyId: number): void; stop(): Promise<void> };

type Options = {
  db: DatabaseSync;
  root: string;
  stateDir: string;
  appConfig: Config;
  query: QueryFn;
  timeoutMs?: number;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function conversationLine(m: ChatContextMessage): string {
  if (m.role === "user") return `User: ${m.text}`;
  const note = m.requestId ? ` (queued request ${m.requestId.slice(0, 8)}: ${m.requestTitle ?? ""})` : "";
  return `Assistant: ${m.text}${note}`;
}

function attentionLine(delivery: Delivery, nested = false): string | null {
  const attention = delivery.attention;
  if (attention === null) return null;
  const flattened = attention.error?.replace(/[\r\n]+/g, " ");
  const error =
    flattened === undefined
      ? null
      : flattened.length > ATTENTION_ERROR_CHARS
        ? `${flattened.slice(0, ATTENTION_ERROR_CHARS - 1)}…`
        : flattened;
  let fact: string;
  if (delivery.state === "incomplete") {
    fact = `incomplete: the last verification found missing work${error === null ? " (no reason recorded)" : `: ${error}`}`;
  } else if (delivery.state === "failed") {
    fact = `request failed${error === null ? " (no reason recorded)" : `: ${error}`}`;
  } else if (delivery.state === "cancelled") {
    fact = "request was cancelled";
  } else {
    fact = `needs attention: step ${attention.id.slice(0, 8)} "${attention.title}" ${error === null ? "was cancelled" : `failed: ${error}`}`;
  }
  const recovery =
    attention.action === "ask-again"
      ? '"Ask for the rest" queues a continuation request.'
      : nested
        ? "Retry it in its own row."
        : delivery.state === "failed" || delivery.state === "cancelled"
          ? "Retry that request."
          : "Retry that step.";
  return `${nested ? "    " : "  "}${fact}. Recovery: ${recovery}`;
}

function queueLines(db: DatabaseSync): string {
  const rows = summarizeQueue(listWorkItems(db)).requests.slice(0, QUEUE_ROWS);
  if (rows.length === 0) return "(empty)";
  return rows
    .map((r) => {
      const error = !r.delivery?.attention && r.error ? ` - ${r.error.slice(0, ERROR_CHARS)}` : "";
      const lines = [`${r.id.slice(0, 8)} "${r.title}" ${r.delivery?.state ?? r.status}${error}`];
      const attention = r.delivery ? attentionLine(r.delivery) : null;
      if (attention !== null) lines.push(attention);
      if (r.followUp !== null) {
        const followUp = r.followUp;
        lines.push(`  continued as request ${followUp.id.slice(0, 8)} "${followUp.title}": ${followUp.delivery.state}`);
        const followUpAttention = attentionLine(followUp.delivery, true);
        if (followUpAttention !== null) lines.push(followUpAttention);
      }
      return lines.join("\n");
    })
    .join("\n");
}

// The role text, the earlier conversation, the queue digest, then the message to answer.
export function buildChatPrompt(db: DatabaseSync, promptText: string, replyId: number): string {
  const latest = db
    .prepare("SELECT text FROM chat_messages WHERE role = 'user' AND id < ? ORDER BY id DESC LIMIT 1")
    .get(replyId) as { text: string } | undefined;
  const context = chatContext(db, replyId);
  // The newest done message before the reply is the latest user message: it has its own section.
  if (context.at(-1)?.role === "user") context.pop();
  const conversation = context.length === 0 ? "(none yet)" : context.map(conversationLine).join("\n");
  return `${[
    promptText.trim(),
    `# Conversation\n\n${conversation}`,
    `# Queue\n\n${queueLines(db)}`,
    `# Latest message\n\n${latest?.text ?? ""}`,
  ].join("\n\n")}\n`;
}

export function createChatRunner(opts: Options): ChatRunner {
  const { db, root, stateDir, appConfig, query } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inFlight = new Map<Promise<void>, AbortController>();

  async function runTurn(replyId: number, abortController: AbortController, timedOut: () => boolean) {
    const signal = abortController.signal;
    let reportedCost: number | undefined;
    const fail = (problem: string) => failChatTurn(db, replyId, problem, reportedCost);
    const stopped = () => fail(timedOut() ? CHAT_TIMED_OUT : INTERRUPTED_TEXT);

    let promptText: string;
    try {
      promptText = readFileSync(join(root, "prompts", "chat.md"), "utf8");
    } catch {
      fail("The chat isn't set up: prompts/chat.md is missing.");
      return;
    }
    const transcript = join(stateDir, "logs", "chat", `${replyId}.jsonl`);
    mkdirSync(join(stateDir, "logs", "chat"), { recursive: true });

    let authFailed = false;
    let result: Record<string, unknown> | null = null;
    let closeError: unknown;
    try {
      const stream = query({
        prompt: buildChatPrompt(db, promptText, replyId),
        options: {
          cwd: root,
          allowedTools: CHAT_TOOLS,
          permissionMode: "dontAsk",
          settingSources: ["project"],
          model: appConfig.models.chat,
          maxTurns: 12,
          maxBudgetUsd: 0.5,
          abortController,
          env: { ...process.env, ADAEGG_STATE_DIR: resolve(stateDir) },
          outputFormat: { type: "json_schema", schema: CHAT_JSON_SCHEMA },
        },
      });
      for await (const message of stream) {
        if (signal.aborted) break;
        for (const line of transcriptLines(message as never)) {
          appendFileSync(transcript, `${JSON.stringify(line)}\n`);
        }
        if (message.type === "assistant" && message.error === "authentication_failed") authFailed = true;
        if (message.type === "result") {
          result = message as unknown as Record<string, unknown>;
          const cost = Number(result.total_cost_usd);
          if (Number.isFinite(cost)) reportedCost = cost;
        }
      }
    } catch (err) {
      // The SDK can reject after yielding messages (nonzero process exit): keep what arrived.
      closeError = err;
    }
    if (signal.aborted) {
      stopped();
      return;
    }

    const resultText = typeof result?.result === "string" ? result.result : "";
    const errorText = Array.isArray(result?.errors) ? result.errors.map(String).join("\n") : "";
    if (authFailed || (result?.is_error === true && AUTH_PATTERN.test(`${resultText}\n${errorText}`))) {
      fail(CHAT_SIGNED_OUT);
      return;
    }
    // A closing exception is only swallowed when a terminal error result explains it.
    if (closeError !== undefined && (!result || result.subtype === "success")) {
      fail(messageOf(closeError));
      return;
    }
    if (!result) {
      fail(CHAT_NO_REPLY);
      return;
    }
    if (result.subtype !== "success") {
      const errors = Array.isArray(result.errors) ? result.errors.join("; ") : "";
      fail(errors ? `${result.subtype}: ${errors}` : String(result.subtype));
      return;
    }
    const parsed = ChatOutputSchema.safeParse(result.structured_output ?? lastJsonBlock(resultText));
    if (!parsed.success) {
      fail(CHAT_NO_REPLY);
      return;
    }
    const { reply, request } = parsed.data;
    finishChatTurn(db, replyId, {
      reply,
      ...(request ? { request } : {}),
      costUsd: reportedCost ?? 0,
    });
  }

  async function turn(replyId: number, abortController: AbortController) {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error("chat reply timed out"));
    }, timeoutMs);
    try {
      await runTurn(replyId, abortController, () => timedOut);
    } catch (err) {
      const aborted = abortController.signal.aborted;
      try {
        failChatTurn(db, replyId, aborted ? (timedOut ? CHAT_TIMED_OUT : INTERRUPTED_TEXT) : messageOf(err));
      } catch {
        // The turn is already lost: nothing more to record.
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    start(replyId) {
      const abortController = new AbortController();
      const promise: Promise<void> = turn(replyId, abortController).finally(() => inFlight.delete(promise));
      inFlight.set(promise, abortController);
    },
    async stop() {
      const running = [...inFlight];
      for (const [, controller] of running) controller.abort(new Error("chat stopped"));
      await Promise.all(running.map(([promise]) => promise));
    },
  };
}
