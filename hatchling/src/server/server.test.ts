import { request } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../engine/db.ts";
import { createUiServer, type UiServer } from "./server.ts";

const servers: UiServer[] = [];

async function begin(port = 0) {
  const server = createUiServer({ db: db(), root: ".", port, vite: false });
  servers.push(server);
  return { server, ...(await server.start()) };
}

function db() {
  return openDb(":memory:");
}

const JSON_HEADERS = { "content-type": "application/json" };

function rawGet(port: number, path: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

function refused(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe("createUiServer", () => {
  it("stop closes upgrade sockets that nothing handles when vite is off", async () => {
    const { server, port } = await begin();
    const closed: Promise<void>[] = [];
    for (const host of [`127.0.0.1:${port}`, "evil.example"]) {
      const socket = connect({ host: "127.0.0.1", port });
      socket.resume(); // an unread socket never sees the server's close
      closed.push(new Promise((resolve) => socket.once("close", () => resolve())));
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await server.stop();
    await Promise.all(closed);
    expect(await refused(port)).toBe(true);
  });

  it("serves state with no-store", async () => {
    const { url } = await begin();
    const res = await fetch(`${url}/api/state`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("creates a request through POST /api/ask", async () => {
    const { url } = await begin();
    const res = await fetch(`${url}/api/ask`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(201);
    const state = (await (await fetch(`${url}/api/state`)).json()) as { queue: { requests: { title: string }[] } };
    expect(state.queue.requests.map((r) => r.title)).toEqual(["hello"]);
  });

  it("refuses a foreign Host for API and other paths", async () => {
    const { port } = await begin();
    expect(await rawGet(port, "/api/state", { Host: "evil.example" })).toBe(403);
    expect(await rawGet(port, "/", { Host: "evil.example" })).toBe(403);
  });

  it("refuses a cross-site Origin", async () => {
    const { url } = await begin();
    const res = await fetch(`${url}/api/ask`, {
      method: "POST",
      headers: { ...JSON_HEADERS, origin: "http://evil.example" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a cross-site Origin on a page-data route", async () => {
    const { url } = await begin();
    const res = await fetch(`${url}/api/pages/water/data/today`, {
      method: "POST",
      headers: { ...JSON_HEADERS, origin: "http://evil.example" },
      body: JSON.stringify({ value: 1 }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a 65 KiB body with 413", async () => {
    const { url } = await begin();
    const res = await fetch(`${url}/api/ask`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "a".repeat(65 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it("rejects invalid JSON with 400 and a non-JSON type with 415", async () => {
    const { url } = await begin();
    const bad = await fetch(`${url}/api/ask`, { method: "POST", headers: JSON_HEADERS, body: "{nope" });
    expect(bad.status).toBe(400);
    const plain = await fetch(`${url}/api/ask`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hi",
    });
    expect(plain.status).toBe(415);
  });

  it("answers 404 for other paths without Vite", async () => {
    const { url } = await begin();
    expect((await fetch(`${url}/`)).status).toBe(404);
  });

  it("falls back to a free port when the port is in use", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const first = await begin();
    const second = await begin(first.port);
    expect(second.port).not.toBe(first.port);
    expect(second.url).toBe(`http://127.0.0.1:${second.port}`);
    const lines = write.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("ui:"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`(port ${first.port})`);
    expect(lines[0]).toContain("is busy");
    expect(lines[0]).toContain("temporary");
    expect(lines[0]?.indexOf("\n")).toBe((lines[0]?.length ?? 0) - 1);
  });

  it("stops twice and then refuses connections", async () => {
    const { server, port } = await begin();
    await server.stop();
    await server.stop();
    expect(await refused(port)).toBe(true);
  });

  it("can be stopped before start", async () => {
    const server = createUiServer({ db: db(), root: ".", port: 0, vite: false });
    await server.stop();
  });
});
