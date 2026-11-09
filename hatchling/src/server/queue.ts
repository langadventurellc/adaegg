import type { ListedWorkItem, Status } from "../engine/store.ts";

export type RequestRow = {
  id: string;
  title: string;
  kind: string;
  status: Status;
  error: string | null;
  createdAt: string;
  progress: { done: number; total: number } | null;
  blockedBy: string[];
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
    const steps = (children.get(item.id) ?? []).filter((c) => c.kind === "item");
    requests.push({
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      error: item.error,
      createdAt: item.createdAt,
      progress:
        steps.length === 0 ? null : { done: steps.filter((c) => c.status === "done").length, total: steps.length },
      blockedBy: item.blockedBy,
    });
    if (requests.length === MAX_ROWS) break;
  }
  return { counts, requests };
}
