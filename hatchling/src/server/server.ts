import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { handleApi } from "./api.ts";
import { checkRequest } from "./guard.ts";

export type UiServerOptions = { db: DatabaseSync; root: string; port: number; vite?: boolean };
export type UiServer = { start(): Promise<{ url: string; port: number }>; stop(): Promise<void> };

const MAX_BODY = 64 * 1024;
const HOST = "127.0.0.1";

type ViteDevServer = {
  middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  close(): Promise<void>;
};

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

type BodyResult = { ok: true; raw: string } | { ok: false };

// Reads at most MAX_BODY bytes; past that it answers 413, closes the connection and reads no more.
function readBody(req: IncomingMessage, res: ServerResponse): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        chunks.length = 0;
        req.pause();
        sendJson(res, 413, { error: "request body too large" }, { Connection: "close" });
        res.once("finish", () => req.destroy());
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve({ ok: true, raw: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => {
      if (done) return;
      done = true;
      resolve({ ok: false });
    });
  });
}

export function createUiServer(opts: UiServerOptions): UiServer {
  const useVite = opts.vite ?? true;
  let vite: ViteDevServer | undefined;
  let boundPort = 0;
  let stopping: Promise<void> | undefined;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const method = req.method ?? "GET";
    const refused = checkRequest({ method, headers: req.headers, port: boundPort });
    if (refused) {
      sendJson(res, refused.status, { error: refused.error });
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      sendJson(res, 400, { error: "malformed url" });
      return;
    }
    if (pathname.startsWith("/api/")) {
      let body: unknown;
      if (method !== "GET" && method !== "HEAD") {
        const read = await readBody(req, res);
        if (!read.ok) return;
        if (read.raw.trim() !== "") {
          try {
            body = JSON.parse(read.raw);
          } catch {
            sendJson(res, 400, { error: "invalid JSON" });
            return;
          }
        }
      }
      const out = handleApi(opts.db, { method, path: pathname, body });
      sendJson(res, out.status, out.body);
      return;
    }
    if (vite) {
      vite.middlewares(req, res, () => sendJson(res, 404, { error: "not found" }));
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      process.stderr.write(`ui: request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      sendJson(res, 500, { error: "internal error" });
    });
  });

  function listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, HOST);
    });
  }

  async function start() {
    try {
      await listen(opts.port);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      process.stderr.write(`ui: port ${opts.port} is in use, using a free port instead\n`);
      await listen(0);
    }
    boundPort = (server.address() as AddressInfo).port;
    if (useVite) {
      try {
        const { createServer: createVite } = await import("vite");
        vite = await createVite({
          root: opts.root,
          server: { middlewareMode: { server }, watch: { ignored: ["**/.adaegg/**"] } },
          optimizeDeps: { entries: ["index.html"] },
          clearScreen: false,
          logLevel: "warn",
        });
      } catch (err) {
        await closeHttp();
        throw err;
      }
    }
    return { url: `http://${HOST}:${boundPort}`, port: boundPort };
  }

  function closeHttp(): Promise<void> {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      if (vite) await vite.close();
      server.closeAllConnections();
      await closeHttp();
    })();
    return stopping;
  }

  return { start, stop };
}
