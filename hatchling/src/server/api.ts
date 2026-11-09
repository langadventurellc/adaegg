import type { DatabaseSync } from "node:sqlite";
import { deletePageData, isPageDataId, listPageData, setPageData } from "../engine/page-data.ts";
import { getSetting, setSetting } from "../engine/settings.ts";
import { addWorkItem, cancelWorkItem, getWorkItem, listWorkItems, retryWorkItem } from "../engine/store.ts";
import { validateName } from "../names/validate.ts";
import { MAX_BODY_BYTES } from "./guard.ts";
import { type QueueSummary, summarizeQueue, titleFromText } from "./queue.ts";

export type ApiRequest = { method: string; path: string; body: unknown };
export type ApiResponse = { status: number; body: unknown };
// The body of GET /api/state; only here so the browser client can import the type.
export type StateResponse = { name: string | null; queue: QueueSummary };

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

// A page id or key from the path, decoded and checked, or an error response.
function pageDataId(raw: string, what: "page" | "key"): string | ApiResponse {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return fail(400, "malformed id");
  }
  if (!isPageDataId(id)) return fail(400, `${what} must be 1-64 letters, digits, "-" or "_"`);
  return id;
}

function pageData(
  db: DatabaseSync,
  req: ApiRequest,
  kind: "list" | "set" | "delete",
  rawPage: string,
  rawKey?: string,
): ApiResponse {
  const page = pageDataId(rawPage, "page");
  if (typeof page !== "string") return page;
  if (kind === "list") return { status: 200, body: { items: listPageData(db, page) } };
  const key = pageDataId(rawKey as string, "key");
  if (typeof key !== "string") return key;
  if (kind === "delete") {
    if (!deletePageData(db, page, key)) return fail(404, "no such key");
    return { status: 200, body: { key } };
  }
  const body = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body) || !Object.hasOwn(body, "value")) {
    return fail(400, "body must be a JSON object with a value");
  }
  const value = (body as { value: unknown }).value;
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BODY_BYTES) return fail(413, "value too large");
  return { status: 200, body: setPageData(db, page, key, value) };
}

export function handleApi(db: DatabaseSync, req: ApiRequest): ApiResponse {
  const { method, path } = req;
  const item = /^\/api\/items\/([^/]+)\/(retry|cancel)$/.exec(path);
  const dataList = /^\/api\/pages\/([^/]+)\/data$/.exec(path);
  const dataSet = /^\/api\/pages\/([^/]+)\/data\/([^/]+)$/.exec(path);
  const dataDelete = /^\/api\/pages\/([^/]+)\/data\/([^/]+)\/delete$/.exec(path);
  let allowed: string;
  if (path === "/api/state" || dataList) allowed = "GET";
  else if (path === "/api/name" || path === "/api/ask" || item || dataSet || dataDelete) allowed = "POST";
  else return fail(404, "not found");
  if (method !== allowed) return fail(405, "method not allowed");

  if (dataList) return pageData(db, req, "list", dataList[1] as string);
  if (dataSet) return pageData(db, req, "set", dataSet[1] as string, dataSet[2] as string);
  if (dataDelete) return pageData(db, req, "delete", dataDelete[1] as string, dataDelete[2] as string);

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
