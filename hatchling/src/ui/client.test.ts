import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../engine/db.ts";
import { addWorkItem, claimNext, failWorkItem, listWorkItems } from "../engine/store.ts";
import { createUiServer, type UiServer } from "../server/server.ts";
import { ApiError, createClient, UnreachableError } from "./client.ts";

let db: ReturnType<typeof openDb>;
let server: UiServer;
let root: string;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
  db = openDb(":memory:");
  root = mkdtempSync(join(tmpdir(), "hatchling-client-"));
  server = createUiServer({ db, root, port: 0, vite: false });
  const { url } = await server.start();
  client = createClient(url);
});

afterEach(async () => {
  await server.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("createClient against the real server", () => {
  it("getState returns no name before setName and the name after", async () => {
    expect((await client.getState()).name).toBeNull();
    expect(await client.setName("Hopper")).toEqual({ name: "Hopper" });
    const state = await client.getState();
    expect(state.name).toBe("Hopper");
    expect(state.queue.requests).toEqual([]);
  });

  it("setName with an invalid name throws ApiError 400 with the message", async () => {
    const err = await client.setName("").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).not.toBe("");
    expect(err.message).not.toBe("HTTP 400");
  });

  it("ask creates a request work item", async () => {
    const res = await client.ask("Make me a water tracker");
    const items = listWorkItems(db);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(res.id);
    expect(items[0]?.kind).toBe("request");
    expect(res.title).toBeTruthy();
  });

  it("retry returns a failed item to queued", async () => {
    const item = addWorkItem(db, { title: "x", kind: "request" });
    claimNext(db, "request");
    failWorkItem(db, item.id, "boom");
    expect(await client.retry(item.id)).toEqual({ id: item.id, status: "queued" });
  });

  it("cancel moves a queued item to cancelled", async () => {
    const item = addWorkItem(db, { title: "x", kind: "request" });
    expect(await client.cancel(item.id)).toEqual({ id: item.id, status: "cancelled" });
  });

  it("retry on a queued item throws ApiError 409", async () => {
    const item = addWorkItem(db, { title: "x", kind: "request" });
    const err = await client.retry(item.id).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
  });

  it("continue posts {} to the continue route and returns the id and title", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "new1", title: "Finish: x" }), { status: 201 });
    }) as unknown as typeof fetch;
    const res = await createClient("http://h", fake).continue("abcd 1234");
    expect(res).toEqual({ id: "new1", title: "Finish: x" });
    expect(calls[0]?.url).toBe("http://h/api/items/abcd%201234/continue");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe("{}");
  });

  it("continue on a request that is not incomplete throws ApiError 409", async () => {
    const item = addWorkItem(db, { title: "x", kind: "request" });
    const err = await client.continue(item.id).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
  });

  it("pageData sets, gets, lists, overwrites and removes", async () => {
    const water = client.pageData("water");
    expect(await water.get("today")).toBeUndefined();
    const set = await water.set("today", { cups: 1 });
    expect(set).toMatchObject({ key: "today", value: { cups: 1 } });
    expect(await water.get("today")).toEqual({ cups: 1 });
    await water.set("today", { cups: 2 });
    expect(await water.list()).toMatchObject([{ key: "today", value: { cups: 2 } }]);
    expect(await water.remove("today")).toEqual({ key: "today" });
    expect(await water.list()).toEqual([]);
  });

  it("pageData keeps pages apart", async () => {
    await client.pageData("water").set("k", 1);
    await client.pageData("journal").set("k", 2);
    expect(await client.pageData("water").get("k")).toBe(1);
    expect(await client.pageData("journal").get("k")).toBe(2);
  });

  it("pageData remove of a missing key throws ApiError 404", async () => {
    const err = await client
      .pageData("water")
      .remove("nope")
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });

  it("pageData with a bad page id throws ApiError 400", async () => {
    const err = await client
      .pageData("Bad Page")
      .list()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
  });

  it("every method throws UnreachableError after stop", async () => {
    await server.stop();
    for (const call of [
      () => client.getState(),
      () => client.setName("Hopper"),
      () => client.ask("hi"),
      () => client.retry("abcd1234"),
      () => client.cancel("abcd1234"),
      () => client.pageData("water").list(),
      () => client.pageData("water").get("today"),
      () => client.pageData("water").set("today", 1),
      () => client.pageData("water").remove("today"),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(UnreachableError);
    }
  });

  it("falls back to HTTP <status> when the error body is not JSON", async () => {
    const fake = createClient("", (async () => new Response("nope", { status: 502 })) as typeof fetch);
    const err = await fake.getState().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("HTTP 502");
  });
});
