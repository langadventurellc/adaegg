import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConfigSchema } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import { readReady } from "../engine/lifecycle.ts";
import { buildTemplateRepo, copyRepo, removeAllRepos, removeCopies } from "../engine/nodes/test-repo.ts";
import { defineNode } from "../engine/nodes/types.ts";
import { addWorkItem, getWorkItem } from "../engine/store.ts";
import type { Workflow } from "../engine/workflows/schema.ts";
import { type StartDeps, startDaemon } from "./main.ts";

const wf: Workflow = {
  id: "w",
  name: "W",
  trigger: { type: "queue", kind: "item" },
  start: "a",
  nodes: [{ id: "a", type: "a", config: {} }],
  edges: [{ from: "a", on: "ok", to: "end" }],
};

let template: string;
beforeAll(() => {
  template = buildTemplateRepo();
});
afterAll(() => removeAllRepos());

let root: string;
let stateDir: string;
let db: DatabaseSync;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = copyRepo(template);
  stateDir = mkdtempSync(join(tmpdir(), "adaegg-state-"));
  db = openDb(":memory:");
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (db.isOpen) db.close();
  rmSync(stateDir, { recursive: true, force: true });
  removeCopies();
});

function start(ui?: StartDeps["ui"]) {
  const exits: number[] = [];
  const node = defineNode({
    type: "a",
    outcomes: ["ok"],
    configSchema: z.object({}).passthrough(),
    run: async () => ({ outcome: "ok" }),
  });
  return startDaemon({
    db,
    workflows: [wf],
    nodeTypes: { a: node },
    appConfig: ConfigSchema.parse({ schema: 1 }),
    paths: { root, stateDir },
    tickMs: 10_000,
    ...(ui ? { ui } : {}),
    exit: (code) => exits.push(code),
  });
}

describe("daemon UI wiring", () => {
  it("starts the ui after the first tick, publishes the url and stops it before closing the db", async () => {
    const events: string[] = [];
    const close = db.close.bind(db);
    db.close = () => {
      events.push("db.close");
      close();
    };
    const ui = {
      start: vi.fn(async () => {
        events.push("ui.start");
        return { url: "http://127.0.0.1:1" };
      }),
      stop: vi.fn(async () => {
        events.push("ui.stop");
      }),
    };
    const started = await start(ui);
    expect(readReady(stateDir)?.url).toBe("http://127.0.0.1:1");
    expect(stdout).toHaveBeenCalledWith("hatchling UI: http://127.0.0.1:1\n");
    await started.shutdown();
    expect(events).toEqual(["ui.start", "ui.stop", "db.close"]);
    expect(readReady(stateDir)).toBeNull();
  });

  it("carries on without a url when the ui fails to start", async () => {
    const ui = {
      start: async (): Promise<{ url: string }> => {
        throw new Error("boom");
      },
      stop: vi.fn(async () => {}),
    };
    const started = await start(ui);
    const ready = readReady(stateDir);
    expect(ready).not.toBeNull();
    expect(ready?.url).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith("daemon: UI failed to start: boom\n");
    const id = addWorkItem(db, { title: "T", contents: "c" }).id;
    await started.daemon.tick();
    expect(getWorkItem(db, id)?.status).not.toBe("queued");
    await started.shutdown();
  });

  it("still shuts down when stopping the ui throws", async () => {
    const ui = {
      start: async () => ({ url: "http://127.0.0.1:1" }),
      stop: async () => {
        throw new Error("stuck");
      },
    };
    const started = await start(ui);
    await started.shutdown();
    expect(db.isOpen).toBe(false);
    expect(readReady(stateDir)).toBeNull();
  });

  it("publishes no url without a ui", async () => {
    const started = await start();
    const ready = readReady(stateDir);
    expect(ready).not.toBeNull();
    expect(ready?.url).toBeUndefined();
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("hatchling UI"));
    await started.shutdown();
  });
});
