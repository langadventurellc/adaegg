import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb } from "../engine/db.ts";
import { createUiServer, type UiServer } from "./server.ts";

// Starting Vite (config load, dependency scan) can near the 5s default on a slow disk.
vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let server: UiServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ui-vite-"));
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><div id="app"></div><script type="module" src="/main.ts"></script>',
  );
  writeFileSync(join(dir, "main.ts"), "");
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

it("serves index.html and its modules through Vite", async () => {
  server = createUiServer({ db: openDb(":memory:"), root: dir, port: 0, vite: true });
  const { url } = await server.start();
  const page = await fetch(`${url}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('id="app"');
  const mod = await fetch(`${url}/main.ts`);
  expect(mod.status).toBe(200);
  expect(mod.headers.get("content-type")).toMatch(/javascript/);
  await server.stop();
});

it("sends no CORS headers, even for another localhost origin", async () => {
  server = createUiServer({ db: openDb(":memory:"), root: dir, port: 0, vite: true });
  const { url } = await server.start();
  for (const path of ["/", "/main.ts"]) {
    const res = await fetch(`${url}${path}`, { headers: { Origin: "http://localhost:5173" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  }
});

type UpgradeResult = { status: number; socket: Socket | null };

// Sends a WebSocket upgrade with the given Host and protocol; resolves with the status line's code.
function upgrade(port: number, host: string, protocol: string): Promise<UpgradeResult> {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: {
        Host: host,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol": protocol,
      },
    });
    req.on("upgrade", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on("response", (res) => resolve({ status: res.statusCode ?? 0, socket: null }));
    req.on("error", () => resolve({ status: 0, socket: null }));
    req.end();
  });
}

function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

it("keeps live reload on the loopback server and opens no second listener", async () => {
  server = createUiServer({ db: openDb(":memory:"), root: dir, port: 0, vite: true });
  const { port } = await server.start();
  expect(await connectRefused(24678)).toBe(true);

  for (const protocol of ["vite-hmr", "vite-ping"]) {
    for (const host of [`evil.example:${port}`, "localhost:1", "127.0.0.1"]) {
      const bad = await upgrade(port, host, protocol);
      expect(bad.status).not.toBe(101);
      bad.socket?.destroy();
    }
  }

  const ok = await upgrade(port, `127.0.0.1:${port}`, "vite-hmr");
  expect(ok.status).toBe(101);
  const closed = new Promise<void>((resolve) => ok.socket?.on("close", () => resolve()));
  await server.stop();
  await closed;
  expect(await connectRefused(port)).toBe(true);
});

it("stop closes allowed-Host upgrades that Vite ignores", async () => {
  server = createUiServer({ db: openDb(":memory:"), root: dir, port: 0, vite: true });
  const { port } = await server.start();
  const host = `127.0.0.1:${port}`;
  const closed: Promise<void>[] = [];
  for (const [protocol, path] of [
    [null, "/"],
    ["unknown-protocol", "/"],
    ["vite-hmr", "/not-the-hmr-path"],
  ] as const) {
    // Raw sockets: an ignored upgrade never gets a response, so there is nothing to await but the close.
    const socket = connect({ host: "127.0.0.1", port });
    socket.resume(); // an unread socket never sees the server's close
    closed.push(new Promise((resolve) => socket.once("close", () => resolve())));
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        (protocol === null ? "" : `Sec-WebSocket-Protocol: ${protocol}\r\n`) +
        "\r\n",
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  await server.stop();
  await Promise.all(closed);
  expect(await connectRefused(port)).toBe(true);
});

it("answers 500 internal error when a module fails to transform", async () => {
  writeFileSync(join(dir, "broken.ts"), "const = ;");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    server = createUiServer({ db: openDb(":memory:"), root: dir, port: 0, vite: true });
    const { url } = await server.start();
    const res = await fetch(`${url}/broken.ts`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  } finally {
    stderr.mockRestore();
  }
});

it("answers 500 internal error when the index html fails to transform", async () => {
  writeFileSync(
    join(dir, "vite.config.mjs"),
    'export default { plugins: [{ name: "boom", transformIndexHtml() { throw new Error("boom"); } }] };',
  );
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    server = createUiServer({ db: openDb(":memory:"), root: dir, port: 0, vite: true });
    const { url } = await server.start();
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  } finally {
    stderr.mockRestore();
  }
});
