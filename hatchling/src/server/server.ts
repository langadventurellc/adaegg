import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { handleApi } from "./api.ts";
import { checkRequest, MAX_BODY_BYTES } from "./guard.ts";

export type UiServerOptions = {
  db: DatabaseSync;
  root: string;
  port: number;
  vite?: boolean;
  chat?: { start(replyId: number): void; stop(): Promise<void> };
};
export type UiServer = { start(): Promise<{ url: string; port: number }>; stop(): Promise<void> };

const HOST = "127.0.0.1";
const viteFailures = new AsyncLocalStorage<{ failed: boolean }>();

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

// Reads at most MAX_BODY_BYTES bytes; past that it answers 413, closes the connection and reads no more.
function readBody(req: IncomingMessage, res: ServerResponse): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
  let shuttingDown = false;

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
      // Checked after the body is read, so a request still arriving when shutdown began is refused too.
      if (shuttingDown && pathname === "/api/chat") {
        sendJson(res, 503, { error: "The hatchling is stopping. Try again once it is back." });
        return;
      }
      const out = handleApi(opts.db, { method, path: pathname, body }, opts.chat ? { chat: opts.chat } : undefined);
      sendJson(res, out.status, out.body);
      return;
    }
    if (vite) {
      // Vite's middleware-mode error handler logs and then calls next() without the error, so the
      // logger hook below flags the request and the fallback tells a failure from a plain miss.
      const failure = { failed: false };
      const middlewares = vite.middlewares;
      viteFailures.run(failure, () =>
        middlewares(req, res, () => {
          if (failure.failed) {
            sendJson(res, 500, { error: "internal error" });
          } else {
            sendJson(res, 404, { error: "not found" });
          }
        }),
      );
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

  // Upgraded sockets leave node's connection list, and an upgrade nobody handles (vite: false, an
  // unknown protocol or path) stays open, so every socket is tracked and destroyed on stop.
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  function destroySockets() {
    for (const socket of sockets) socket.destroy();
  }

  // Registered before Vite attaches its own upgrade listener, so it runs first. Vite's listener only
  // acts on the vite-hmr and vite-ping protocols and its Host check is skipped for vite-ping and does
  // not check the port, so a refused upgrade is closed here and its protocol header is blanked so
  // Vite's listener ignores the socket.
  server.on("upgrade", (req, socket) => {
    const refused = checkRequest({ method: "GET", headers: req.headers, port: boundPort });
    if (!refused) return;
    req.headers["sec-websocket-protocol"] = "";
    socket.end(`HTTP/1.1 ${refused.status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
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
      process.stderr.write(
        `ui: this hatchling's usual address (port ${opts.port}) is busy because another program is using it, so it is on a temporary address this time\n`,
      );
      await listen(0);
    }
    boundPort = (server.address() as AddressInfo).port;
    if (useVite) {
      try {
        const { createServer: createVite, createLogger } = await import("vite");
        const logger = createLogger("warn");
        const logError = logger.error.bind(logger);
        logger.error = (msg, options) => {
          const failure = viteFailures.getStore();
          if (failure && options?.error) failure.failed = true;
          logError(msg, options);
        };
        vite = await createVite({
          root: opts.root,
          // cors: false because Vite allows loopback origins by default and this server sends no CORS headers.
          // ws.server keeps live reload on this loopback server; without it Vite opens a second listener
          // on port 24678 on every interface.
          server: { middlewareMode: { server }, ws: { server }, watch: { ignored: ["**/.adaegg/**"] }, cors: false },
          optimizeDeps: { entries: ["index.html"] },
          clearScreen: false,
          logLevel: "warn",
          customLogger: logger,
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
      destroySockets();
    });
  }

  function stop(): Promise<void> {
    shuttingDown = true;
    stopping ??= (async () => {
      await opts.chat?.stop();
      if (vite) await vite.close();
      server.closeAllConnections();
      destroySockets();
      await closeHttp();
    })();
    return stopping;
  }

  return { start, stop };
}
