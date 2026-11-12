import type { StateResponse } from "../server/api.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class UnreachableError extends Error {
  constructor(message = "The hatchling is not reachable") {
    super(message);
    this.name = "UnreachableError";
  }
}

export type PageDataItem = { key: string; value: unknown; updatedAt: string };

export function createClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const init: RequestInit =
      method === "GET"
        ? { method }
        : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, init);
    } catch (err) {
      throw new UnreachableError(err instanceof Error ? err.message : undefined);
    }
    let parsed: unknown;
    let isJson = true;
    try {
      parsed = await res.json();
    } catch {
      isJson = false;
    }
    if (!res.ok) {
      const error = (parsed as { error?: unknown } | null)?.error;
      throw new ApiError(res.status, isJson && typeof error === "string" ? error : `HTTP ${res.status}`);
    }
    if (!isJson) throw new ApiError(res.status, `HTTP ${res.status}`);
    return parsed as T;
  }

  const item = (id: string, action: "retry" | "cancel") =>
    call<{ id: string; status: string }>("POST", `/api/items/${encodeURIComponent(id)}/${action}`, {});

  const pageData = (pageId: string) => {
    const base = `/api/pages/${encodeURIComponent(pageId)}/data`;
    const list = async () => (await call<{ items: PageDataItem[] }>("GET", base)).items;
    return {
      list,
      get: async (key: string): Promise<unknown> => (await list()).find((entry) => entry.key === key)?.value,
      set: (key: string, value: unknown) => call<PageDataItem>("POST", `${base}/${encodeURIComponent(key)}`, { value }),
      remove: (key: string) => call<{ key: string }>("POST", `${base}/${encodeURIComponent(key)}/delete`, {}),
    };
  };

  return {
    pageData,
    getState: () => call<StateResponse>("GET", "/api/state"),
    setName: (name: string) => call<{ name: string }>("POST", "/api/name", { name }),
    ask: (text: string) => call<{ id: string; title: string }>("POST", "/api/ask", { text }),
    chat: (text: string) => call<{ messageId: number; replyId: number }>("POST", "/api/chat", { text }),
    retry: (id: string) => item(id, "retry"),
    cancel: (id: string) => item(id, "cancel"),
    continue: (id: string) =>
      call<{ id: string; title: string }>("POST", `/api/items/${encodeURIComponent(id)}/continue`, {}),
  };
}

// For page code: `pageData("water").set("today", 3)`.
export const pageData = (pageId: string) => createClient("").pageData(pageId);
