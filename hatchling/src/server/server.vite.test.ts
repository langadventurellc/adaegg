import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
