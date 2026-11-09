import { EXHAUSTED_ROUNDS_PREFIX } from "../engine/nodes/enqueue.ts";
import type { ListedWorkItem, Status } from "../engine/store.ts";

export type Delivery = {
  state:
    | "planning"
    | "building"
    | "verifying"
    | "delivered"
    | "needs-attention"
    | "incomplete"
    | "failed"
    | "cancelled";
  attention: { id: string; title: string; error: string | null; action: "retry" | "ask-again" } | null;
};

export type RequestRow = {
  id: string;
  title: string;
  kind: string;
  status: Status;
  error: string | null;
  createdAt: string;
  progress: { done: number; total: number } | null;
  blockedBy: string[];
  delivery: Delivery | null;
};

export type QueueSummary = { counts: Record<Status, number>; requests: RequestRow[] };

const MAX_TITLE = 80;
const MAX_ROWS = 20;

export function titleFromText(text: string): string {
  const line = text.split(/\r\n|\r|\n/).find((l) => l.trim() !== "");
  if (line === undefined) return "";
  const chars = [...line.replace(/\s+/g, " ").trim()];
  if (chars.length <= MAX_TITLE) return chars.join("");
  return `${chars.slice(0, MAX_TITLE - 1).join("")}…`;
}

export function deliveryOf(parent: ListedWorkItem, children: ListedWorkItem[]): Delivery {
  if (parent.status === "queued" || parent.status === "in_progress") return { state: "planning", attention: null };
  if (parent.status === "failed") {
    return {
      state: "failed",
      attention: { id: parent.id, title: parent.title, error: parent.error, action: "retry" },
    };
  }
  if (parent.status === "cancelled") {
    return {
      state: "cancelled",
      attention: { id: parent.id, title: parent.title, error: null, action: "retry" },
    };
  }
  const broken = (c: ListedWorkItem) => c.status === "failed" || c.status === "cancelled";
  const step = children.find((c) => c.kind === "item" && broken(c));
  if (step !== undefined) {
    return {
      state: "needs-attention",
      attention: { id: step.id, title: step.title, error: step.error, action: "retry" },
    };
  }
  const verify = children.find((c) => c.kind === "verify" && broken(c));
  if (verify !== undefined) {
    const exhausted = verify.status === "failed" && verify.error?.startsWith(EXHAUSTED_ROUNDS_PREFIX) === true;
    return {
      state: exhausted ? "incomplete" : "needs-attention",
      attention: {
        id: verify.id,
        title: verify.title,
        error: verify.error,
        action: exhausted ? "ask-again" : "retry",
      },
    };
  }
  if (children.some((c) => c.status === "queued" || c.status === "in_progress")) {
    const onlyVerifications = children.filter((c) => c.kind === "item").every((c) => c.status === "done");
    return { state: onlyVerifications ? "verifying" : "building", attention: null };
  }
  return { state: "delivered", attention: null };
}

export function progressOf(children: ListedWorkItem[]): { done: number; total: number } | null {
  const steps = children.filter((c) => c.kind === "item");
  return steps.length === 0 ? null : { done: steps.filter((c) => c.status === "done").length, total: steps.length };
}

export function summarizeQueue(items: ListedWorkItem[]): QueueSummary {
  const counts: Record<Status, number> = { queued: 0, in_progress: 0, done: 0, failed: 0, cancelled: 0 };
  const children = new Map<string, ListedWorkItem[]>();
  for (const item of items) {
    counts[item.status]++;
    if (item.parentId !== null) {
      const list = children.get(item.parentId) ?? [];
      list.push(item);
      children.set(item.parentId, list);
    }
  }
  const requests: RequestRow[] = [];
  // Newest first by creation time; ties follow reverse input order (listWorkItems is oldest first).
  const ordered = items.map((item, index) => ({ item, index }));
  ordered.sort((a, b) =>
    a.item.createdAt === b.item.createdAt ? b.index - a.index : a.item.createdAt < b.item.createdAt ? 1 : -1,
  );
  for (const { item } of ordered) {
    if (item.parentId !== null || (item.kind !== "request" && item.kind !== "item")) continue;
    requests.push({
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      error: item.error,
      createdAt: item.createdAt,
      progress: progressOf(children.get(item.id) ?? []),
      blockedBy: item.blockedBy,
      delivery: item.kind === "request" ? deliveryOf(item, children.get(item.id) ?? []) : null,
    });
    if (requests.length === MAX_ROWS) break;
  }
  return { counts, requests };
}
