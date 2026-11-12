import type { DatabaseSync } from "node:sqlite";
import { titleFromText } from "../server/queue.ts";
import { addWorkItem, inTransaction } from "./store.ts";

export class ChatBusyError extends Error {
  constructor() {
    super("a chat reply is still pending");
    this.name = "ChatBusyError";
  }
}

export type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  status: "pending" | "done" | "failed";
  requestId: string | null;
  requestTitle: string | null;
  createdAt: string;
};

export type ChatContextMessage = {
  role: "user" | "assistant";
  text: string;
  requestId: string | null;
  requestTitle: string | null;
};

export const INTERRUPTED_TEXT = "This reply was interrupted by a restart. Send your message again.";

const CONTEXT_MESSAGES = 20;
const CONTEXT_FETCH = 40;
const CONTEXT_TEXT_CHARS = 4000;
const OPEN_USER_CHARS = 40_000;

export function isChatBusy(db: DatabaseSync): boolean {
  return (
    db.prepare("SELECT 1 AS x FROM chat_messages WHERE role = 'assistant' AND status = 'pending' LIMIT 1").get() !==
    undefined
  );
}

export function addChatTurn(db: DatabaseSync, text: string): { userId: number; replyId: number } {
  try {
    return inTransaction(db, () => {
      if (isChatBusy(db)) throw new ChatBusyError();
      const now = new Date().toISOString();
      const insert = db.prepare("INSERT INTO chat_messages (role, text, status, created_at) VALUES (?, ?, ?, ?)");
      const userId = Number(insert.run("user", text, "done", now).lastInsertRowid);
      const replyId = Number(insert.run("assistant", "", "pending", now).lastInsertRowid);
      return { userId, replyId };
    });
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) throw new ChatBusyError();
    throw err;
  }
}

export function listChatMessages(db: DatabaseSync, limit = 50): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT m.id, m.role, m.text, m.status, m.request_id, m.created_at, w.title AS request_title
         FROM chat_messages m LEFT JOIN work_items w ON w.id = m.request_id
         ORDER BY m.id DESC LIMIT ?
       ) ORDER BY id`,
    )
    .all(limit);
  return rows.map((r) => ({
    id: r.id as number,
    role: r.role as ChatMessage["role"],
    text: r.text as string,
    status: r.status as ChatMessage["status"],
    requestId: (r.request_id as string | null) ?? null,
    requestTitle: (r.request_title as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

export function finishChatTurn(
  db: DatabaseSync,
  replyId: number,
  result: { reply: string; request?: { title: string; contents: string }; costUsd?: number },
): void {
  inTransaction(db, () => {
    const requestId = result.request
      ? addWorkItem(db, {
          kind: "request",
          title: titleFromText(result.request.title),
          contents: result.request.contents,
        }).id
      : null;
    const changes = db
      .prepare(
        `UPDATE chat_messages SET text = ?, status = 'done', request_id = ?, cost_usd = ?
         WHERE id = ? AND role = 'assistant' AND status = 'pending'`,
      )
      .run(result.reply, requestId, result.costUsd ?? null, replyId).changes;
    if (Number(changes) === 0) throw new Error(`chat reply ${replyId} is not pending`);
  });
}

// costUsd keeps what the SDK reported for a turn that still failed.
export function failChatTurn(db: DatabaseSync, replyId: number, problem: string, costUsd?: number): void {
  db.prepare(
    "UPDATE chat_messages SET status = 'failed', text = ?, cost_usd = COALESCE(?, cost_usd) WHERE id = ? AND role = 'assistant' AND status = 'pending'",
  ).run(problem, costUsd ?? null, replyId);
}

export function failInterruptedTurns(db: DatabaseSync): number {
  const changes = db
    .prepare("UPDATE chat_messages SET status = 'failed', text = ? WHERE role = 'assistant' AND status = 'pending'")
    .run(INTERRUPTED_TEXT).changes;
  return Number(changes);
}

export function chatContext(db: DatabaseSync, replyId: number): ChatContextMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT m.id, m.role, m.text, m.request_id, w.title AS request_title
         FROM chat_messages m LEFT JOIN work_items w ON w.id = m.request_id
         WHERE m.status = 'done' AND m.id < ?
         ORDER BY m.id DESC LIMIT ?
       ) ORDER BY id`,
    )
    .all(replyId, CONTEXT_FETCH);
  // Messages after the newest queued request are the ask the chat is still working on. They stay whole (within a
  // budget) and the window reaches back to the first of them, so a late requirement in a long ask survives the
  // clarifying questions before it is queued.
  const queued = db
    .prepare(
      "SELECT MAX(id) AS id FROM chat_messages WHERE role = 'assistant' AND status = 'done' AND request_id IS NOT NULL AND id < ?",
    )
    .get(replyId);
  const lastQueuedId = (queued?.id as number | null | undefined) ?? 0;
  const isOpen = (r: Record<string, unknown>) => (r.id as number) > lastQueuedId;
  const firstOpen = rows.findIndex(isOpen);
  const start =
    firstOpen === -1
      ? Math.max(0, rows.length - CONTEXT_MESSAGES)
      : Math.min(firstOpen, Math.max(0, rows.length - CONTEXT_MESSAGES));
  let fullChars = 0;
  let seenOpenUser = false;
  return rows.slice(start).map((r) => {
    const full = r.text as string;
    let text = full.slice(0, CONTEXT_TEXT_CHARS);
    if (r.role === "user" && isOpen(r)) {
      if (!seenOpenUser || fullChars + full.length <= OPEN_USER_CHARS) {
        text = full;
        fullChars += full.length;
      }
      seenOpenUser = true;
    }
    return {
      role: r.role as ChatContextMessage["role"],
      text,
      requestId: (r.request_id as string | null) ?? null,
      requestTitle: (r.request_title as string | null) ?? null,
    };
  });
}
