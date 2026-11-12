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
});
