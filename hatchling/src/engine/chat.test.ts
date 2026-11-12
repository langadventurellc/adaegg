import { describe, expect, it } from "vitest";
import {
  addChatTurn,
  ChatBusyError,
  chatContext,
  failChatTurn,
  failInterruptedTurns,
  finishChatTurn,
  INTERRUPTED_TEXT,
  isChatBusy,
  listChatMessages,
} from "./chat.ts";
import { openDb } from "./db.ts";
import { listWorkItems } from "./store.ts";

function row(db: ReturnType<typeof openDb>, id: number) {
  return db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id);
}

// Adds a finished turn and returns its reply id.
function doneTurn(db: ReturnType<typeof openDb>, text: string, reply: string): number {
  const { replyId } = addChatTurn(db, text);
  finishChatTurn(db, replyId, { reply });
  return replyId;
}

describe("addChatTurn", () => {
  it("inserts a done user message and a pending empty reply", () => {
    const db = openDb(":memory:");
    const { userId, replyId } = addChatTurn(db, "hello");
    expect(row(db, userId)).toMatchObject({ role: "user", text: "hello", status: "done" });
    expect(row(db, replyId)).toMatchObject({ role: "assistant", text: "", status: "pending" });
    expect(isChatBusy(db)).toBe(true);
  });

  it("refuses a second turn while one is pending and works again after", () => {
    const db = openDb(":memory:");
    const { replyId } = addChatTurn(db, "one");
    expect(() => addChatTurn(db, "two")).toThrow(ChatBusyError);
    expect(listChatMessages(db)).toHaveLength(2);
    finishChatTurn(db, replyId, { reply: "ok" });
    expect(isChatBusy(db)).toBe(false);
    expect(() => addChatTurn(db, "two")).not.toThrow();
  });

  it("lets the database itself refuse a second pending reply", () => {
    const db = openDb(":memory:");
    addChatTurn(db, "one");
    expect(() =>
      db
        .prepare("INSERT INTO chat_messages (role, text, status, created_at) VALUES ('assistant', '', 'pending', 'x')")
        .run(),
    ).toThrow(/UNIQUE/);
  });
});

describe("finishChatTurn", () => {
  it("creates the request, links it and stores cost and text", () => {
    const db = openDb(":memory:");
    const { replyId } = addChatTurn(db, "a button");
    finishChatTurn(db, replyId, {
      reply: "Queued.",
      request: { title: "Add a button\nsecond line", contents: "Full details" },
      costUsd: 0.12,
    });
    const items = listWorkItems(db);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "request", title: "Add a button", contents: "Full details" });
    expect(row(db, replyId)).toMatchObject({
      text: "Queued.",
      status: "done",
      request_id: items[0]?.id,
      cost_usd: 0.12,
    });
  });

  it("creates no work item without a request", () => {
    const db = openDb(":memory:");
    const { replyId } = addChatTurn(db, "what pages?");
    finishChatTurn(db, replyId, { reply: "Two pages." });
    expect(listWorkItems(db)).toEqual([]);
    expect(row(db, replyId)).toMatchObject({ text: "Two pages.", status: "done", request_id: null, cost_usd: null });
  });

  it("rolls back the work item when the reply is not pending", () => {
    const db = openDb(":memory:");
    const replyId = doneTurn(db, "q", "answer");
    const before = row(db, replyId);
    expect(() => finishChatTurn(db, replyId, { reply: "x", request: { title: "t", contents: "c" } })).toThrow(
      /not pending/,
    );
    expect(() => finishChatTurn(db, 9999, { reply: "x", request: { title: "t", contents: "c" } })).toThrow(
      /not pending/,
    );
    expect(listWorkItems(db)).toEqual([]);
    expect(row(db, replyId)).toEqual(before);
  });
});

describe("failChatTurn and failInterruptedTurns", () => {
  it("fails a pending reply with the problem", () => {
    const db = openDb(":memory:");
    const { replyId } = addChatTurn(db, "q");
    failChatTurn(db, replyId, "boom");
    expect(row(db, replyId)).toMatchObject({ status: "failed", text: "boom" });
    expect(isChatBusy(db)).toBe(false);
  });

  it("does not touch a done reply", () => {
    const db = openDb(":memory:");
    const replyId = doneTurn(db, "q", "answer");
    failChatTurn(db, replyId, "boom");
    expect(row(db, replyId)).toMatchObject({ status: "done", text: "answer" });
  });

  it("fails pending replies on restart, counts them and leaves done rows", () => {
    const db = openDb(":memory:");
    const doneId = doneTurn(db, "q", "answer");
    const { replyId } = addChatTurn(db, "q2");
    expect(failInterruptedTurns(db)).toBe(1);
    expect(row(db, replyId)).toMatchObject({ status: "failed", text: INTERRUPTED_TEXT });
    expect(row(db, doneId)).toMatchObject({ status: "done", text: "answer" });
    expect(failInterruptedTurns(db)).toBe(0);
  });
});

describe("listChatMessages", () => {
  it("returns the last messages oldest first with the request title", () => {
    const db = openDb(":memory:");
    doneTurn(db, "first", "r1");
    const { replyId } = addChatTurn(db, "second");
    finishChatTurn(db, replyId, { reply: "r2", request: { title: "Do it", contents: "c" } });
    const all = listChatMessages(db);
    expect(all.map((m) => m.text)).toEqual(["first", "r1", "second", "r2"]);
    expect(all[3]).toMatchObject({ requestTitle: "Do it", role: "assistant", status: "done" });
    expect(all[3]?.requestId).toEqual(expect.any(String));
    expect(all[2]).toMatchObject({ requestId: null, requestTitle: null });
    expect(listChatMessages(db, 2).map((m) => m.text)).toEqual(["second", "r2"]);
  });
});

describe("chatContext", () => {
  it("leaves out failed and pending messages and anything from the reply on", () => {
    const db = openDb(":memory:");
    doneTurn(db, "first", "r1");
    const failed = addChatTurn(db, "second");
    failChatTurn(db, failed.replyId, "bad");
    const { replyId } = addChatTurn(db, "third");
    const ctx = chatContext(db, replyId);
    expect(ctx.map((m) => m.text)).toEqual(["first", "r1", "second", "third"]);
  });

  it("caps at 20 messages, cuts long texts and carries the request", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 12; i++) doneTurn(db, `m${i}`, "r");
    const { replyId } = addChatTurn(db, "x".repeat(5000));
    finishChatTurn(db, replyId, { reply: "ok", request: { title: "T", contents: "c" } });
    const next = addChatTurn(db, "next");
    const ctx = chatContext(db, next.replyId);
    expect(ctx).toHaveLength(20);
    expect(ctx[0]?.text).toBe("r");
    const long = ctx.find((m) => m.text.startsWith("xxx"));
    expect(long?.text).toHaveLength(4000);
    expect(ctx.at(-2)).toMatchObject({ role: "assistant", requestTitle: "T" });
    expect(ctx.at(-1)).toMatchObject({ role: "user", text: "next", requestId: null });
  });

  it("keeps an unresolved ask in full through a clarifying question", () => {
    const db = openDb(":memory:");
    const ask = `${"a".repeat(8500)}LAST-REQUIREMENT${"b".repeat(484)}`;
    doneTurn(db, ask, "Which page?");
    const { replyId } = addChatTurn(db, "the home page");
    const ctx = chatContext(db, replyId);
    expect(ctx.map((m) => m.text.length)).toEqual([9000, 11, 13]);
    expect(ctx[0]?.text).toContain("LAST-REQUIREMENT");
    expect(ctx[2]?.text).toBe("the home page");
  });

  it("cuts a resolved ask but keeps a new ask after the queued request in full", () => {
    const db = openDb(":memory:");
    const { replyId } = addChatTurn(db, "x".repeat(5000));
    finishChatTurn(db, replyId, { reply: "ok", request: { title: "T", contents: "c" } });
    doneTurn(db, "y".repeat(6000), "question?");
    const next = addChatTurn(db, "answer");
    const ctx = chatContext(db, next.replyId);
    expect(ctx.map((m) => m.text.length)).toEqual([4000, 2, 6000, 9, 6]);
  });

  it("keeps open user messages in full up to the budget, counted from the oldest", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 4; i++) doneTurn(db, "u".repeat(10_000), "q");
    const { replyId } = addChatTurn(db, "u".repeat(10_000));
    const users = chatContext(db, replyId).filter((m) => m.role === "user");
    expect(users.map((m) => m.text.length)).toEqual([10_000, 10_000, 10_000, 10_000, 4000]);
  });

  it("extends the window back to the start of the open ask, at most 40 messages", () => {
    const db = openDb(":memory:");
    doneTurn(db, "the ask", "q0");
    for (let i = 1; i <= 11; i++) doneTurn(db, `a${i}`, `q${i}`);
    const { replyId } = addChatTurn(db, "last");
    const ctx = chatContext(db, replyId);
    expect(ctx).toHaveLength(25);
    expect(ctx[0]?.text).toBe("the ask");

    const long = openDb(":memory:");
    doneTurn(long, "the ask", "q0");
    for (let i = 1; i <= 21; i++) doneTurn(long, `a${i}`, `q${i}`);
    const last = addChatTurn(long, "last");
    const longCtx = chatContext(long, last.replyId);
    expect(longCtx).toHaveLength(40);
    expect(longCtx.at(-1)?.text).toBe("last");
  });

  it("cuts open assistant messages to 4000 characters", () => {
    const db = openDb(":memory:");
    doneTurn(db, "ask", "r".repeat(6000));
    const { replyId } = addChatTurn(db, "answer");
    expect(chatContext(db, replyId)[1]?.text).toHaveLength(4000);
  });
});
