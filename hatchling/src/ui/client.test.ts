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

  it("every method throws UnreachableError after stop", async () => {
    await server.stop();
    for (const call of [
      () => client.getState(),
      () => client.setName("Hopper"),
      () => client.ask("hi"),
      () => client.retry("abcd1234"),
      () => client.cancel("abcd1234"),
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
