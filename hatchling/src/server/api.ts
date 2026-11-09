import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "../engine/settings.ts";
import { addWorkItem, cancelWorkItem, getWorkItem, listWorkItems, retryWorkItem } from "../engine/store.ts";
import { validateName } from "../names/validate.ts";
import { summarizeQueue, titleFromText } from "./queue.ts";

export type ApiRequest = { method: string; path: string; body: unknown };
export type ApiResponse = { status: number; body: unknown };

const MAX_ASK_LENGTH = 10_000;

function fail(status: number, error: string): ApiResponse {
  return { status, body: { error } };
}

// The one string field of a JSON object body, or an error response.
function stringField(body: unknown, field: string): string | ApiResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(400, "body must be a JSON object");
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string") return fail(400, `${field} must be a string`);
  return value;
}

function transitionItem(db: DatabaseSync, rawId: string, action: "retry" | "cancel"): ApiResponse {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return fail(400, "malformed id");
  }
  try {
    const item = getWorkItem(db, id);
    const changed = action === "retry" ? retryWorkItem(db, item.id) : cancelWorkItem(db, item.id);
    return { status: 200, body: { id: changed.id, status: changed.status } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/^(no work item matches|id prefix too short|ambiguous)/.test(message)) return fail(404, message);
    if (message.startsWith(`cannot ${action} `)) return fail(409, message);
    throw err;
  }
}

export function handleApi(db: DatabaseSync, req: ApiRequest): ApiResponse {
  const { method, path } = req;
  const item = /^\/api\/items\/([^/]+)\/(retry|cancel)$/.exec(path);
  let allowed: string;
  if (path === "/api/state") allowed = "GET";
  else if (path === "/api/name" || path === "/api/ask" || item) allowed = "POST";
  else return fail(404, "not found");
  if (method !== allowed) return fail(405, "method not allowed");

  if (path === "/api/state") {
    return { status: 200, body: { name: getSetting(db, "name"), queue: summarizeQueue(listWorkItems(db)) } };
  }
  if (item) return transitionItem(db, item[1] as string, item[2] as "retry" | "cancel");
  if (path === "/api/name") {
    const raw = stringField(req.body, "name");
    if (typeof raw !== "string") return raw;
    const result = validateName(raw);
    if (!result.ok) return fail(400, result.error);
    setSetting(db, "name", result.name);
    return { status: 200, body: { name: result.name } };
  }
  const raw = stringField(req.body, "text");
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (text === "") return fail(400, "text must not be empty");
  if ([...text].length > MAX_ASK_LENGTH) return fail(400, `text must be at most ${MAX_ASK_LENGTH} characters`);
  const created = addWorkItem(db, { kind: "request", title: titleFromText(text), contents: text });
  return { status: 201, body: { id: created.id, title: created.title } };
}
