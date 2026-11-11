import type { ListedWorkItem } from "../engine/store.ts";

export const FOLLOW_UP_HEADER = "Finish the request ";

// The request that carries the rest of an incomplete request, unless it failed or was cancelled.
export function followUpOf(requestId: string, items: ListedWorkItem[]): ListedWorkItem | undefined {
  const prefix = `${FOLLOW_UP_HEADER}${requestId.slice(0, 8)} `;
  return items.find(
    (c) => c.kind === "request" && c.contents.startsWith(prefix) && c.status !== "failed" && c.status !== "cancelled",
  );
}
