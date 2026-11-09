import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../engine/db.ts";
import { addWorkItem, claimNext, failWorkItem, finishWorkItem, getWorkItem, listWorkItems } from "../engine/store.ts";
import { handleApi } from "./api.ts";

const get = (db: ReturnType<typeof openDb>, path: string) => handleApi(db, { method: "GET", path, body: undefined });
const post = (db: ReturnType<typeof openDb>, path: string, body?: unknown) =>
  handleApi(db, { method: "POST", path, body });

describe("handleApi state and name", () => {
  it("reports no name at first", () => {
    const res = get(openDb(":memory:"), "/api/state");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: null, queue: { requests: [] } });
  });

  it("stores the cleaned name", () => {
    const db = openDb(":memory:");
    expect(post(db, "/api/name", { name: "  Pip   Moss " })).toEqual({ status: 200, body: { name: "Pip Moss" } });
    expect(get(db, "/api/state").body).toMatchObject({ name: "Pip Moss" });
  });

  it.each(["", "1abc"])("rejects the name %j", (name) => {
    const res = post(openDb(":memory:"), "/api/name", { name });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).not.toBe("");
  });

  it("rejects a name that is not a string", () => {
    expect(post(openDb(":memory:"), "/api/name", { name: 3 }).status).toBe(400);
  });
});

describe("handleApi ask", () => {
  it("creates a request item", () => {
    const db = openDb(":memory:");
    const res = post(db, "/api/ask", { text: "  Add a dark mode\nwith a toggle  " });
    expect(res.status).toBe(201);
    const body = res.body as { id: string; title: string };
    expect(body.title).toBe("Add a dark mode");
    const stored = getWorkItem(db, body.id);
    expect(stored).toMatchObject({
      kind: "request",
      title: "Add a dark mode",
      contents: "Add a dark mode\nwith a toggle",
      priority: 0,
      status: "queued",
    });
  });

  it.each([{ text: "" }, { text: "  \n " }, { text: 5 }, { text: "a".repeat(10_001) }, {}])("rejects %j", (body) => {
    const db = openDb(":memory:");
    expect(post(db, "/api/ask", body).status).toBe(400);
    expect(listWorkItems(db)).toHaveLength(0);
  });

  it("accepts exactly 10,000 characters", () => {
    expect(post(openDb(":memory:"), "/api/ask", { text: "a".repeat(10_000) }).status).toBe(201);
  });

  it.each([[[]], [null], ["x"], [3], [undefined]])("rejects the body %j", (body) => {
    expect(post(openDb(":memory:"), "/api/ask", body).status).toBe(400);
  });
});

describe("handleApi retry and cancel", () => {
  it("requeues a failed item", () => {
    const db = openDb(":memory:");
    const added = addWorkItem(db, { title: "x" });
    claimNext(db, "item");
    failWorkItem(db, added.id, "boom");
    expect(post(db, `/api/items/${added.id}/retry`, {})).toEqual({
      status: 200,
      body: { id: added.id, status: "queued" },
    });
  });

  it("refuses to retry a queued item", () => {
    const db = openDb(":memory:");
    const added = addWorkItem(db, { title: "x" });
    const res = post(db, `/api/items/${added.id}/retry`);
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toContain("cannot retry");
  });

  it("answers 404 for an unknown, too short or malformed-but-unmatched id", () => {
    const db = openDb(":memory:");
    expect(post(db, "/api/items/nonexistent/retry").status).toBe(404);
    expect(post(db, "/api/items/ab/cancel").status).toBe(404);
  });

  it("answers 400 for a malformed id escape", () => {
    expect(post(openDb(":memory:"), "/api/items/%E0%A4%A/cancel").status).toBe(400);
  });

  it("cancels a queued item by prefix", () => {
    const db = openDb(":memory:");
    const added = addWorkItem(db, { title: "x" });
    expect(post(db, `/api/items/${added.id.slice(0, 8)}/cancel`).body).toEqual({ id: added.id, status: "cancelled" });
  });
});

describe("handleApi delivery", () => {
  it("reports delivery and follows a retried child step", () => {
    const db = openDb(":memory:");
    const request = addWorkItem(db, { title: "req", kind: "request" });
    claimNext(db, "request");
    finishWorkItem(db, request.id);
    const child = addWorkItem(db, { title: "step one", parentId: request.id });
    claimNext(db, "item");
    failWorkItem(db, child.id, "boom");

    const rowOf = () =>
      (get(db, "/api/state").body as { queue: { requests: Array<{ id: string; status: string; delivery: unknown }> } })
        .queue.requests[0];
    expect(rowOf()).toMatchObject({
      status: "done",
      delivery: {
        state: "needs-attention",
        attention: { id: child.id, title: "step one", error: "boom", action: "retry" },
      },
    });

    expect(post(db, `/api/items/${child.id}/retry`, {}).status).toBe(200);
    expect(rowOf()?.delivery).toEqual({ state: "building", attention: null });
  });
});

describe("handleApi page data", () => {
  it("sets, lists and deletes", () => {
    const db = openDb(":memory:");
    const set = post(db, "/api/pages/water/data/today", { value: { cups: 3 } });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ key: "today", value: { cups: 3 } });
    expect(typeof (set.body as { updatedAt: string }).updatedAt).toBe("string");
    post(db, "/api/pages/journal/data/today", { value: "other" });
    expect(get(db, "/api/pages/water/data")).toEqual({
      status: 200,
      body: { items: [set.body] },
    });
    expect(post(db, "/api/pages/water/data/today/delete", {})).toEqual({ status: 200, body: { key: "today" } });
    expect(get(db, "/api/pages/water/data").body).toEqual({ items: [] });
  });

  it("accepts null and a key named delete", () => {
    const db = openDb(":memory:");
    expect(post(db, "/api/pages/p/data/delete", { value: null }).body).toMatchObject({ key: "delete", value: null });
  });

  it("answers 404 deleting a missing key", () => {
    expect(post(openDb(":memory:"), "/api/pages/water/data/nope/delete", {}).status).toBe(404);
  });

  it.each([
    "/api/pages/Bad%20Page/data",
    "/api/pages/a.b/data",
    `/api/pages/${"a".repeat(65)}/data`,
    "/api/pages/%E0%A4%A/data",
  ])("answers 400 for a bad page in %s", (path) => {
    expect(get(openDb(":memory:"), path).status).toBe(400);
  });

  it.each(["a.b", "a%20b", "a".repeat(65), "%E0%A4%A"])("answers 400 for the bad key %s", (key) => {
    const db = openDb(":memory:");
    expect(post(db, `/api/pages/water/data/${key}`, { value: 1 }).status).toBe(400);
    expect(post(db, `/api/pages/water/data/${key}/delete`, {}).status).toBe(400);
  });

  it.each([{}, [], null, "x", 3, undefined])("answers 400 for the body %j without a value", (body) => {
    expect(post(openDb(":memory:"), "/api/pages/water/data/today", body).status).toBe(400);
  });

  it("answers 413 for a value over 64 KiB", () => {
    const db = openDb(":memory:");
    expect(post(db, "/api/pages/water/data/big", { value: "a".repeat(64 * 1024) }).status).toBe(413);
    expect(get(db, "/api/pages/water/data").body).toEqual({ items: [] });
  });

  it("answers 405 for the wrong method", () => {
    const db = openDb(":memory:");
    expect(post(db, "/api/pages/water/data", {}).status).toBe(405);
    expect(get(db, "/api/pages/water/data/today").status).toBe(405);
    expect(get(db, "/api/pages/water/data/today/delete").status).toBe(405);
  });

  it("survives closing and reopening the db file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hatchling-page-data-"));
    try {
      const file = join(dir, "state", "db.sqlite");
      const db = openDb(file);
      post(db, "/api/pages/water/data/today", { value: [1, 2] });
      db.close();
      const again = openDb(file);
      expect((get(again, "/api/pages/water/data").body as { items: unknown[] }).items).toMatchObject([
        { key: "today", value: [1, 2] },
      ]);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("handleApi routing", () => {
  it("answers 404 for an unknown path", () => {
    expect(get(openDb(":memory:"), "/api/nope").status).toBe(404);
  });

  it("answers 405 for the wrong method", () => {
    const db = openDb(":memory:");
    expect(get(db, "/api/ask").status).toBe(405);
    expect(post(db, "/api/state", {}).status).toBe(405);
    expect(get(db, "/api/items/abcd/retry").status).toBe(405);
  });
});
