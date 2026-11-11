import type { DatabaseSync } from "node:sqlite";
import { addWorkItem, getWorkItem, listWorkItems, type WorkItem } from "../engine/store.ts";
import { FOLLOW_UP_HEADER, followUpOf } from "./followup.ts";
import { deliveryOf, titleFromText } from "./queue.ts";

const MAX_FINDINGS = 2_000;
const MAX_BUILT = 30;
const ORIGINAL_HEADING = "## Original request\n";
const BUILT_HEADING = "\n\n## Already built\n";

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

// The request text a continuation wraps, or the contents unchanged for a plain request.
function unwrap(request: WorkItem): { title: string; contents: string } {
  if (!request.contents.startsWith(FOLLOW_UP_HEADER)) return { title: request.title, contents: request.contents };
  const start = request.contents.indexOf(`\n${ORIGINAL_HEADING}`);
  const end = request.contents.lastIndexOf(BUILT_HEADING);
  if (start === -1 || end <= start) return { title: request.title, contents: request.contents };
  const contents = request.contents.slice(start + 1 + ORIGINAL_HEADING.length, end).replace(/^\n+|\n+$/g, "");
  return { title: request.title.replace(/^Finish: /, ""), contents };
}

// Queues a new request that carries the whole original request, what was built and what was still missing.
export function continueRequest(db: DatabaseSync, idOrPrefix: string): WorkItem {
  const request = getWorkItem(db, idOrPrefix);
  const id8 = request.id.slice(0, 8);
  if (request.kind !== "request" || request.parentId !== null) {
    throw new Error(`cannot continue ${id8}: only a request can be continued`);
  }
  const all = listWorkItems(db);
  const children = all.filter((c) => c.parentId === request.id);
  const delivery = deliveryOf({ ...request, blockedBy: [] }, children);
  if (delivery.state !== "incomplete") {
    throw new Error(`cannot continue ${id8}: it is ${delivery.state}, not incomplete`);
  }
  const existing = followUpOf(request.id, all);
  if (existing !== undefined) {
    throw new Error(`cannot continue ${id8}: already continued by request ${existing.id.slice(0, 8)}`);
  }

  const findings = truncate(delivery.attention?.error ?? "", MAX_FINDINGS);
  const done = children.filter((c) => c.kind === "item" && c.status === "done");
  const lines = done.slice(-MAX_BUILT).map((c, i) => `${i + 1}. ${c.id.slice(0, 8)} ${c.title}`);
  if (done.length > MAX_BUILT) lines.push("(earlier steps left out)");
  const built = lines.length === 0 ? "Nothing was built." : lines.join("\n");

  const original = unwrap(request);
  const contents = [
    `${FOLLOW_UP_HEADER}${id8} "${original.title}". Part of it was already built. Build only what is still missing and do not redo the built work.`,
    "",
    "## Original request",
    original.contents,
    "",
    "## Already built",
    built,
    "",
    "## Still missing",
    "The last verification found this was still missing (these are titles only, so check the code against the original request):",
    findings,
  ].join("\n");
  return addWorkItem(db, { kind: "request", title: titleFromText(`Finish: ${original.title}`), contents });
}
