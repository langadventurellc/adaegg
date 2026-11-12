import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addChatTurn, finishChatTurn, INTERRUPTED_TEXT, listChatMessages } from "../engine/chat.ts";
import { type Config, ConfigSchema } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import type { QueryFn } from "../engine/nodes/agent.ts";
import { addWorkItem, listWorkItems } from "../engine/store.ts";
import { CHAT_JSON_SCHEMA, createChatRunner } from "./chat.ts";

type Msg = Record<string, unknown>;

function result(extra: Msg = {}): Msg {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    total_cost_usd: 0.02,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra,
  };
}

type Call = { prompt: string; options: Record<string, unknown> };

function fakeQuery(calls: Call[], script: (call: Call) => Msg[] | AsyncGenerator<Msg>): QueryFn {
  return ((params: Call) => {
    calls.push(params);
    const out = script(params);
    return (async function* () {
      for await (const m of out as AsyncIterable<Msg>) yield m;
    })();
  }) as unknown as QueryFn;
}

let db: DatabaseSync;
let dir: string;
let config: Config;

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(join(tmpdir(), "chat-runner-"));
  mkdirSync(join(dir, "prompts"));
  copyFileSync(resolve("prompts/chat.md"), join(dir, "prompts", "chat.md"));
  config = ConfigSchema.parse({ schema: 1 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function runner(query: QueryFn, extra: { timeoutMs?: number; appConfig?: Config } = {}) {
  return createChatRunner({ db, root: dir, stateDir: join(dir, "state"), appConfig: config, query, ...extra });
}

async function settled(replyId: number) {
  for (let i = 0; i < 500; i++) {
    const m = listChatMessages(db).find((x) => x.id === replyId);
    if (m && m.status !== "pending") return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("turn did not settle");
}

async function turn(query: QueryFn, text = "hello", extra: { timeoutMs?: number; appConfig?: Config } = {}) {
  const r = runner(query, extra);
  const { replyId } = addChatTurn(db, text);
  r.start(replyId);
  const message = await settled(replyId);
  await r.stop();
  return { message, replyId };
}

describe("chat runner", () => {
  it("queues the request the agent wrote and links it", async () => {
    const { message } = await turn(
      fakeQuery([], () => [
        result({
          structured_output: {
            reply: "Queued: Tip page.",
            request: { title: "Add a tip page", contents: "A tip page." },
          },
        }),
      ]),
    );
    const requests = listWorkItems(db).filter((w) => w.kind === "request");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.title).toBe("Add a tip page");
    expect(requests[0]?.contents).toBe("A tip page.");
    expect(message.status).toBe("done");
    expect(message.text).toBe("Queued: Tip page.");
    expect(message.requestId).toBe(requests[0]?.id);
    const cost = db.prepare("SELECT cost_usd FROM chat_messages WHERE id = ?").get(message.id);
    expect(cost?.cost_usd).toBe(0.02);
  });

  it("creates no work item for a question", async () => {
    const { message } = await turn(fakeQuery([], () => [result({ structured_output: { reply: "Which currency?" } })]));
    expect(message.status).toBe("done");
    expect(message.requestId).toBeNull();
    expect(listWorkItems(db)).toHaveLength(0);
  });

  it("falls back to the last json block of the result text", async () => {
    const text = 'Here:\n```json\n{"reply":"Hi there"}\n```\n';
    const { message } = await turn(fakeQuery([], () => [result({ result: text })]));
    expect(message.text).toBe("Hi there");
  });

  it.each([
    ["an empty reply", { structured_output: { reply: "" } }],
    ["no output", {}],
    ["a request without contents", { structured_output: { reply: "x", request: { title: "t", contents: "" } } }],
  ])("fails with the retry text for %s", async (_name, extra) => {
    const { message } = await turn(fakeQuery([], () => [result(extra)]));
    expect(message.status).toBe("failed");
    expect(message.text).toBe("I couldn't write a reply. Send your message again.");
    expect(listWorkItems(db)).toHaveLength(0);
  });

  it("fails with the signed-out text on an authentication error", async () => {
    const { message } = await turn(
      fakeQuery([], () => [{ type: "assistant", error: "authentication_failed", message: { content: [] } }]),
    );
    expect(message.status).toBe("failed");
    expect(message.text).toBe(
      "Claude isn't signed in. Run `claude` once to log in, or set ANTHROPIC_API_KEY, then send your message again.",
    );
  });

  it("fails with the subtype for error_max_turns", async () => {
    const { message } = await turn(fakeQuery([], () => [result({ subtype: "error_max_turns", is_error: true })]));
    expect(message.status).toBe("failed");
    expect(message.text).toBe("error_max_turns");
  });

  it("passes exactly the read-only options", async () => {
    const calls: Call[] = [];
    const custom = ConfigSchema.parse({ schema: 1, models: { chat: "haiku" } });
    await turn(
      fakeQuery(calls, () => [result({ structured_output: { reply: "ok" } })]),
      "hello",
      { appConfig: custom },
    );
    const options = calls[0]?.options as Record<string, unknown>;
    const { env, abortController, ...rest } = options;
    expect(rest).toEqual({
      cwd: dir,
      allowedTools: [
        "Read",
        "Glob",
        "Grep",
        "Bash(git log*)",
        "Bash(git show*)",
        "Bash(git diff*)",
        "Bash(git status*)",
        "Bash(ls *)",
      ],
      permissionMode: "dontAsk",
      settingSources: ["project"],
      model: "haiku",
      maxTurns: 12,
      maxBudgetUsd: 0.5,
      outputFormat: { type: "json_schema", schema: CHAT_JSON_SCHEMA },
    });
    const tools = rest.allowedTools as string[];
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Bash");
    expect((env as Record<string, string>).ADAEGG_STATE_DIR).toBe(resolve(dir, "state"));
    expect(abortController).toBeInstanceOf(AbortController);
  });

  it("puts the earlier turns, the queue and the latest message in the prompt", async () => {
    const first = addChatTurn(db, "first ask");
    finishChatTurn(db, first.replyId, {
      reply: "Queued it.",
      request: { title: "Build the first thing", contents: "c" },
    });
    const failed = addChatTurn(db, "second ask");
    db.prepare("UPDATE chat_messages SET status = 'failed', text = 'FAILED-REPLY' WHERE id = ?").run(failed.replyId);
    const existing = addWorkItem(db, { kind: "request", title: "Other request", contents: "x" });

    const calls: Call[] = [];
    await turn(
      fakeQuery(calls, () => [result({ structured_output: { reply: "ok" } })]),
      "newest ask",
    );
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt.startsWith("# Role: chat")).toBe(true);
    const conversation = prompt.slice(prompt.indexOf("# Conversation"), prompt.indexOf("# Queue"));
    expect(conversation).toContain("User: first ask");
    const queued = listWorkItems(db).find((w) => w.title === "Build the first thing");
    expect(conversation).toContain(
      `Assistant: Queued it. (queued request ${queued?.id.slice(0, 8)}: Build the first thing)`,
    );
    expect(conversation).toContain("User: second ask");
    expect(conversation).not.toContain("FAILED-REPLY");
    expect(conversation).not.toContain("newest ask");
    const queue = prompt.slice(prompt.indexOf("# Queue"), prompt.indexOf("# Latest message"));
    expect(queue).toContain(`${existing.id.slice(0, 8)} "Other request" planning`);
    expect(prompt.slice(prompt.indexOf("# Latest message"))).toContain("newest ask");
  });

  it("fails a turn whose query throws", async () => {
    const { message } = await turn((() => {
      throw new Error("boom");
    }) as unknown as QueryFn);
    expect(message.status).toBe("failed");
    expect(message.text).toBe("boom");
  });

  it("fails an aborted turn as interrupted when stopped", async () => {
    const waiting = fakeQuery([], (call) =>
      (async function* () {
        const signal = (call.options.abortController as AbortController).signal;
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
        yield result();
      })(),
    );
    const r = runner(waiting);
    const { replyId } = addChatTurn(db, "hello");
    r.start(replyId);
    await new Promise((res) => setTimeout(res, 20));
    await expect(r.stop()).resolves.toBeUndefined();
    const message = listChatMessages(db).find((m) => m.id === replyId);
    expect(message?.status).toBe("failed");
    expect(message?.text).toBe(INTERRUPTED_TEXT);
  });

  it("fails a turn that runs past the timeout", async () => {
    const waiting = fakeQuery([], (call) =>
      (async function* () {
        const signal = (call.options.abortController as AbortController).signal;
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
        yield result();
      })(),
    );
    const { message } = await turn(waiting, "hello", { timeoutMs: 20 });
    expect(message.status).toBe("failed");
    expect(message.text).toBe("The reply took too long. Send your message again.");
  });

  it("fails the turn when the prompt file is missing", async () => {
    rmSync(join(dir, "prompts", "chat.md"));
    const { message } = await turn(fakeQuery([], () => [result({ structured_output: { reply: "ok" } })]));
    expect(message.status).toBe("failed");
  });

  it("writes the transcript under logs/chat", async () => {
    const { replyId } = await turn(
      fakeQuery([], () => [
        { type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } },
        result({ structured_output: { reply: "ok" } }),
      ]),
    );
    const file = join(dir, "state", "logs", "chat", `${replyId}.jsonl`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain('"thinking"');
  });
});
