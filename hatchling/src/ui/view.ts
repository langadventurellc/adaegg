import type { NameEntry } from "../names/names.ts";
import type { Delivery, RequestRow } from "../server/queue.ts";

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

export type Route = { kind: "ask" } | { kind: "page"; id: string } | { kind: "not-found"; id: string };

// `#` or `#/` is the Ask screen, `#/<id>` a known page. Anything else is not-found; its id is the raw
// remainder, for display only (always escaped). Never throws.
export function routeFor(hash: string, pages: readonly { id: string }[]): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "" || path === "/") return { kind: "ask" };
  if (!path.startsWith("/")) return { kind: "not-found", id: path };
  let raw = path.slice(1);
  if (raw.endsWith("/")) raw = raw.slice(0, -1);
  if (raw === "") return { kind: "ask" };
  if (raw.includes("/")) return { kind: "not-found", id: raw };
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return { kind: "not-found", id: raw };
  }
  return pages.some((page) => page.id === id) ? { kind: "page", id } : { kind: "not-found", id: raw };
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

export function describeDelivery(delivery: Delivery, row: Pick<RequestRow, "status" | "blockedBy">): string {
  switch (delivery.state) {
    case "planning":
      return describeStatus(row);
    case "building":
      return "Building";
    case "verifying":
      return "Checking the result";
    case "delivered":
      return "Delivered";
    case "needs-attention":
      return "Needs attention";
    case "incomplete":
      return "Incomplete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function renderDeliveryRow(row: RequestRow, delivery: Delivery): string {
  const id = escapeHtml(row.id);
  const progress = progressLabel(row.progress);
  const parts = [
    `<li class="request" data-status="${escapeHtml(delivery.state)}">`,
    `<span class="request-title">${escapeHtml(row.title)}</span>`,
    `<span class="status">${describeDelivery(delivery, row)}</span>`,
  ];
  if (progress !== "" && delivery.state !== "delivered") {
    parts.push(`<span class="progress">${escapeHtml(progress)}</span>`);
  }
  const attention = delivery.attention;
  if (attention !== null) {
    let message: string | null;
    if (delivery.state === "failed" || delivery.state === "cancelled") {
      message = attention.error;
    } else if (delivery.state === "incomplete") {
      message = `The request may still be missing work.${attention.error === null ? "" : ` ${attention.error}`}`;
    } else {
      const head = `${attention.title} ${attention.error === null ? "was cancelled" : "failed"}`;
      message = attention.error === null ? head : `${head}: ${attention.error}`;
    }
    if (message !== null) parts.push(`<p class="request-error">${escapeHtml(message)}</p>`);
    if (attention.action === "retry") {
      parts.push(`<button type="button" data-action="retry" data-id="${escapeHtml(attention.id)}">Retry</button>`);
    } else {
      const text = `Finish the work still missing from: ${row.title}`;
      parts.push(
        `<button type="button" class="starter" data-action="starter" data-text="${escapeHtml(text)}">Ask for the rest</button>`,
      );
    }
  }
  if (row.status === "queued") {
    parts.push(`<button type="button" data-action="cancel" data-id="${id}">Cancel</button>`);
  }
  parts.push("</li>");
  return parts.join("");
}

function renderRow(row: RequestRow): string {
  if (row.delivery !== null) return renderDeliveryRow(row, row.delivery);
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

export function renderAsk(input: {
  name: string;
  starters: readonly string[];
  requests?: RequestRow[];
  pages?: readonly { id: string; title: string }[];
}): string {
  const pages = input.pages ?? [];
  const yourPages =
    pages.length === 0
      ? ""
      : [
          '<section class="your-pages">',
          "<h2>Your pages</h2>",
          '<ul class="pages">',
          ...pages.map((page) => `<li><a href="#/${escapeHtml(page.id)}">${escapeHtml(page.title)}</a></li>`),
          "</ul>",
          "</section>",
        ].join("");
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
    yourPages,
    '<section class="your-requests">',
    "<h2>Your requests</h2>",
    `<div id="requests">${renderRequests(input.requests ?? [])}</div>`,
    "</section>",
    '<button type="button" class="small" data-action="rename">Change name</button>',
  ].join("");
}

export function renderPageHeader(name: string): string {
  return `<header class="page-header"><a href="#/">Ask ${escapeHtml(name)}</a></header>`;
}

export function renderNotFound(name: string): string {
  return `${renderPageHeader(name)}<p>This page doesn&#39;t exist.</p>`;
}

export function renderPageError(message: string): string {
  return `<p class="error" role="alert">${escapeHtml(message)}</p>`;
}

export function renderBanner(kind: "restarting" | "error", message: string): string {
  const role = kind === "restarting" ? "status" : "alert";
  return `<div class="banner banner-${kind}" role="${role}">${escapeHtml(message)}</div>`;
}
