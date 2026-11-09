import { createHash } from "node:crypto";
import { createServer } from "node:net";

export const PORT_BASE = 4747;
export const PORT_SPAN = 1000;

// Picks a port for a hatchling: the hash of its folder decides where the search starts, then the
// first port from there (wrapping within the range) that `isFree` accepts is used.
export async function choosePort(target: string, isFree: (port: number) => Promise<boolean>): Promise<number> {
  const offset = createHash("sha256").update(target).digest().readUInt32BE(0) % PORT_SPAN;
  for (let i = 0; i < PORT_SPAN; i++) {
    const port = PORT_BASE + ((offset + i) % PORT_SPAN);
    if (await isFree(port)) return port;
  }
  throw new Error(`no free port between ${PORT_BASE} and ${PORT_BASE + PORT_SPAN - 1}`);
}

export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => server.close(() => resolvePromise(true)));
    server.listen(port, "127.0.0.1");
  });
}
