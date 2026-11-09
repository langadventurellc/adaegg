import type { NameEntry } from "../names/names.ts";
import type { RequestRow } from "../server/queue.ts";

export const RESTARTING_MESSAGE = "Your hatchling is restarting. This page will reconnect by itself.";

export type Screen = "unreachable" | "onboarding" | "ask";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

export function screenFor(state: { name: string | null } | null, editingName: boolean, unreachable: boolean): Screen {
  if (unreachable) return "unreachable";
  if (state === null || state.name === null) return "onboarding";
  if (editingName) return "onboarding";
  return "ask";
}

export function describeStatus(row: Pick<RequestRow, "status" | "blockedBy">): string {
  switch (row.status) {
    case "queued":
      return row.blockedBy.length > 0 ? "Waiting for other work" : "Waiting";
    case "in_progress":
      return "Working";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function progressLabel(progress: { done: number; total: number } | null): string {
  return progress === null ? "" : `${progress.done} of ${progress.total} done`;
}

function renderRow(row: RequestRow): string {
  const id = escapeHtml(row.id);
  const progress = progressLabel(row.progress);
  const parts = [
    `<li class="request" data-status="${escapeHtml(row.status)}">`,
    `<span class="request-title">${escapeHtml(row.title)}</span>`,
    `<span class="status">${describeStatus(row)}</span>`,
  ];
  if (progress !== "") parts.push(`<span class="progress">${escapeHtml(progress)}</span>`);
  if (row.status === "failed") {
    if (row.error !== null) parts.push(`<p class="request-error">${escapeHtml(row.error)}</p>`);
    parts.push(`<button type="button" data-action="retry" data-id="${id}">Retry</button>`);
  }
  if (row.status === "queued") {
    parts.push(`<button type="button" data-action="cancel" data-id="${id}">Cancel</button>`);
  }
  parts.push("</li>");
  return parts.join("");
}

export function renderRequests(rows: RequestRow[]): string {
  if (rows.length === 0) {
    return '<ul class="requests" aria-live="polite"><li class="empty">No requests yet. Ask for something above.</li></ul>';
  }
  return `<ul class="requests" aria-live="polite">${rows.map(renderRow).join("")}</ul>`;
}

export function renderOnboarding(input: {
  suggestion: NameEntry | null;
  value: string;
  error: string | null;
  current: string | null;
}): string {
  const heading = input.current === null ? "Name your hatchling" : `Rename ${escapeHtml(input.current)}`;
  const suggestion =
    input.suggestion === null
      ? ""
      : `<p class="suggestion">How about <b>${escapeHtml(input.suggestion.name)}</b>? Named for ${escapeHtml(input.suggestion.person)}, who ${escapeHtml(input.suggestion.knownFor)}.</p>`;
  const error = input.error === null ? "" : `<p class="error" role="alert">${escapeHtml(input.error)}</p>`;
  return [
    `<h1>${heading}</h1>`,
    "<p>A hatchling is named like a person or a product.</p>",
    suggestion,
    '<form id="name-form">',
    '<label for="name-input">Name</label>',
    `<input id="name-input" name="name" type="text" value="${escapeHtml(input.value)}" autocomplete="off">`,
    error,
    '<button type="submit" class="primary">Choose this name</button>',
    '<button type="button" class="secondary" data-action="another">Another suggestion</button>',
    "</form>",
  ].join("");
}

export function renderAsk(input: { name: string; starters: readonly string[]; requests?: RequestRow[] }): string {
  const starters = input.starters
    .map(
      (text) =>
        `<button type="button" class="starter" data-action="starter" data-text="${escapeHtml(text)}">${escapeHtml(text)}</button>`,
    )
    .join("");
  return [
    `<h1>Ask ${escapeHtml(input.name)}</h1>`,
    '<form id="ask-form">',
    '<label for="ask-text">What would you like it to do?</label>',
    '<textarea id="ask-text" name="text" rows="4"></textarea>',
    '<button type="submit" class="primary">Ask</button>',
    "</form>",
    '<section class="starters">',
    "<h2>Not sure where to start?</h2>",
    starters,
    "</section>",
    '<section class="your-requests">',
    "<h2>Your requests</h2>",
    `<div id="requests">${renderRequests(input.requests ?? [])}</div>`,
    "</section>",
    '<button type="button" class="small" data-action="rename">Change name</button>',
  ].join("");
}

export function renderBanner(kind: "restarting" | "error", message: string): string {
  const role = kind === "restarting" ? "status" : "alert";
  return `<div class="banner banner-${kind}" role="${role}">${escapeHtml(message)}</div>`;
}
