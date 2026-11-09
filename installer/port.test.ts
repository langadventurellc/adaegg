import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { choosePort, PORT_BASE, PORT_SPAN, portIsFree } from "./port.ts";

const startOf = (path: string) => PORT_BASE + (createHash("sha256").update(path).digest().readUInt32BE(0) % PORT_SPAN);
const LAST = PORT_BASE + PORT_SPAN - 1;

describe("choosePort", () => {
  it("gives the same hash-derived start port for the same path", async () => {
    const free = async () => true;
    const a = await choosePort("/srv/eggs/pip", free);
    const b = await choosePort("/srv/eggs/pip", free);
    expect(a).toBe(b);
    expect(a).toBe(startOf("/srv/eggs/pip"));
  });

  it("takes the next port when the start is busy", async () => {
    const start = startOf("/x/y");
    const port = await choosePort("/x/y", async (p) => p !== start);
    expect(port).toBe(start === LAST ? PORT_BASE : start + 1);
  });

  it("wraps from the last port to the first", async () => {
    let path = "";
    for (let i = 0; ; i++) {
      path = `/candidate/${i}`;
      if (startOf(path) === LAST) break;
    }
    expect(await choosePort(path, async (p) => p === PORT_BASE)).toBe(PORT_BASE);
  });

  it("throws when every port is busy", async () => {
    await expect(choosePort("/x", async () => false)).rejects.toThrow("no free port between 4747 and 5746");
  });
});

describe("portIsFree", () => {
  it("is false while a server holds the port and true after it closes", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(await portIsFree(port)).toBe(false);
    await new Promise((r) => server.close(r));
    expect(await portIsFree(port)).toBe(true);
  });
});
