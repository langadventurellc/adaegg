import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import { createAgentNode, createReviewNode, type QueryFn } from "../engine/nodes/agent.ts";
import { builtinNodeTypes } from "../engine/nodes/index.ts";
import { buildTemplateRepo, copyRepo, removeAllRepos, removeCopies, sh } from "../engine/nodes/test-repo.ts";
import type { NodeRegistry } from "../engine/nodes/types.ts";
import { addWorkItem, getWorkItem, listWorkItems } from "../engine/store.ts";
import { loadWorkflows } from "../engine/workflows/load.ts";
import { handleApi } from "../server/api.ts";
import type { RequestRow } from "../server/queue.ts";
import { renderRequests } from "../ui/view.ts";
import { createDaemon, type Daemon } from "./daemon.ts";

const hatchlingRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let template: string;
beforeAll(() => {
  template = buildTemplateRepo();
  cpSync(join(hatchlingRoot, "workflows"), join(template, "workflows"), { recursive: true });
  cpSync(join(hatchlingRoot, "prompts"), join(template, "prompts"), { recursive: true });
  sh(template, "add", "-A");
  sh(template, "commit", "-m", "add the shipped workflow and prompts");
});

type Msg = Record<string, unknown>;
type Role = "implement" | "review" | "planner" | "verifier";
type Call = { role: Role; prompt: string };
type PlanItem = { key: string; title: string; contents: string; dependsOn: string[] };

const result = (extra: Msg = {}): Msg => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  total_cost_usd: 0.1,
  usage: { input_tokens: 10, output_tokens: 5 },
  ...extra,
});

const planResult = (summary: string, items: PlanItem[]): Msg => result({ structured_output: { summary, items } });

const planItem = (key: string, dependsOn: string[] = []): PlanItem => ({
  key,
  title: `Step ${key}`,
  contents: `Do step ${key}.`,
  dependsOn,
});

function roleOf(prompt: string): Role {
  if (prompt.startsWith("# Role: planner")) return "planner";
  if (prompt.startsWith("# Role: verifier")) return "verifier";
  if (prompt.startsWith("# Role: reviewer")) return "review";
  return "implement";
}

let root: string;
let db: DatabaseSync;
let daemons: Daemon[];

// Fake `query`: tells the role from the prompt and records every call. Planner and verifier must run in the root.
function fakeQuery(calls: Call[], script: (call: Call, nth: number, cwd: string) => Msg[]): QueryFn {
  return ((params: { prompt: string; options: { cwd: string } }) => {
    const role = roleOf(params.prompt);
    const call = { role, prompt: params.prompt };
    calls.push(call);
    const nth = calls.filter((c) => c.role === role).length;
    if (role === "planner" || role === "verifier") expect(params.options.cwd).toBe(root);
    return (async function* () {
      for (const m of script(call, nth, params.options.cwd)) yield m;
    })();
  }) as unknown as QueryFn;
}

function commitFile(cwd: string, name: string) {
  writeFileSync(join(cwd, name), `${name}\n`);
  sh(cwd, "add", "-A");
  sh(cwd, "commit", "-m", `add ${name}`);
}

beforeEach(() => {
  root = copyRepo(template);
  db = openDb(":memory:");
  daemons = [];
});
afterEach(async () => {
  for (const d of daemons) await d.stop();
  db.close();
  removeCopies();
});
afterAll(removeAllRepos);

function makeDaemon(query: QueryFn): Daemon {
  writeFileSync(join(root, "adaegg.json"), `${JSON.stringify({ schema: 1, setup: "", checks: "true" })}\n`);
  sh(root, "add", "-A");
  sh(root, "commit", "-m", "configure checks");
  const nodeTypes: NodeRegistry = {
    ...builtinNodeTypes,
    agent: createAgentNode({ query }),
    review: createReviewNode({ query }),
  };
  const daemon = createDaemon({
    db,
    workflows: loadWorkflows(join(root, "workflows"), nodeTypes),
    nodeTypes,
    appConfig: ConfigSchema.parse(JSON.parse(readFileSync(join(root, "adaegg.json"), "utf8"))),
    paths: { root, stateDir: join(root, ".adaegg") },
    tickMs: 10_000,
  });
  daemons.push(daemon);
  return daemon;
}

// Ticks until no item is queued or running.
async function settle(daemon: Daemon) {
  for (let i = 0; i < 1000; i++) {
    await daemon.tick();
    if (listWorkItems(db).every((w) => w.status !== "queued" && w.status !== "in_progress")) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting");
}

// Stops when nothing runs and everything still queued waits behind a blocker.
async function settleBlocked(daemon: Daemon) {
  for (let i = 0; i < 1000; i++) {
    await daemon.tick();
    const items = listWorkItems(db);
    if (
      items.every((w) => w.status !== "in_progress") &&
      items.every((w) => w.status !== "queued" || w.blockedBy.length > 0)
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting");
}

// What the user sees in Ask: the request row from GET /api/state and its markup.
function seen(requestId: string) {
  const res = handleApi(db, { method: "GET", path: "/api/state", body: undefined });
  const body = res.body as { queue: { requests: RequestRow[] } };
  const row = body.queue.requests.find((r) => r.id === requestId);
  if (!row) throw new Error("request row missing");
  return { row, html: renderRequests(body.queue.requests) };
}

describe("request and verify workflows end to end", () => {
  it("plans a request into two chained items and a verification that passes", async () => {
    const calls: Call[] = [];
    const order: string[] = [];
    const daemon = makeDaemon(
      fakeQuery(calls, (call, nth, cwd) => {
        if (call.role === "planner") return [planResult("two steps", [planItem("one"), planItem("two", ["one"])])];
        if (call.role === "verifier") return [planResult("all delivered", [])];
        if (call.role === "review") return [result({ structured_output: { verdict: "approve", findings: [] } })];
        order.push(call.prompt.includes("Step one") ? "one" : "two");
        // The second item starts only after the first one merged into the main checkout.
        if (nth === 2) expect(existsSync(join(root, "impl-1.txt"))).toBe(true);
        commitFile(cwd, `impl-${nth}.txt`);
        return [result()];
      }),
    );
    const request = addWorkItem(db, { title: "Build the thing", contents: "Please build the thing.", kind: "request" });
    await settle(daemon);

    const items = listWorkItems(db);
    expect(items.map((w) => w.status)).toEqual(items.map(() => "done"));
    expect(items).toHaveLength(4);
    expect(order).toEqual(["one", "two"]);
    expect(calls.filter((c) => c.role === "planner")).toHaveLength(1);
    expect(calls.filter((c) => c.role === "verifier")).toHaveLength(1);
    expect(getWorkItem(db, request.id).status).toBe("done");
    for (const w of items.filter((i) => i.id !== request.id)) {
      expect(w.parentId).toBe(request.id);
      expect(w.sourceId).toBe(request.id);
    }
    expect(items.filter((w) => w.kind === "item")).toHaveLength(2);
    expect(items.filter((w) => w.kind === "verify")).toHaveLength(1);
    expect(sh(root, "status", "--porcelain")).toBe("");
    const final = seen(request.id);
    expect(final.row.delivery?.state).toBe("delivered");
    expect(final.html).toContain("Delivered");
  }, 60_000);

  it("shows building, not Done, while the first step is still running", async () => {
    let midFlight: ReturnType<typeof seen> | undefined;
    let requestId = "";
    const daemon = makeDaemon(
      fakeQuery([], (call, nth, cwd) => {
        if (call.role === "planner") return [planResult("two steps", [planItem("one"), planItem("two", ["one"])])];
        if (call.role === "verifier") return [planResult("all delivered", [])];
        if (call.role === "review") return [result({ structured_output: { verdict: "approve", findings: [] } })];
        if (nth === 1) midFlight = seen(requestId);
        commitFile(cwd, `impl-${nth}.txt`);
        return [result()];
      }),
    );
    requestId = addWorkItem(db, { title: "Build the thing", contents: "Please build the thing.", kind: "request" }).id;
    await settle(daemon);

    expect(getWorkItem(db, requestId).status).toBe("done");
    expect(midFlight?.row.status).toBe("done");
    expect(midFlight?.row.delivery?.state).toBe("building");
    expect(midFlight?.html).not.toContain("Done");
  }, 60_000);

  it("needs attention when a step is blocked, and delivers after Retry", async () => {
    let failImplementer = true;
    const daemon = makeDaemon(
      fakeQuery([], (call, nth, cwd) => {
        if (call.role === "planner") return [planResult("two steps", [planItem("one"), planItem("two", ["one"])])];
        if (call.role === "verifier") return [planResult("all delivered", [])];
        if (call.role === "review") return [result({ structured_output: { verdict: "approve", findings: [] } })];
        if (failImplementer) {
          return [
            { type: "assistant", error: "authentication_failed", message: { content: [] } },
            result({ subtype: "success", is_error: true, result: "Invalid API key" }),
          ];
        }
        commitFile(cwd, `impl-${nth}.txt`);
        return [result()];
      }),
    );
    const request = addWorkItem(db, { title: "Build the thing", contents: "Please build the thing.", kind: "request" });
    await settleBlocked(daemon);

    const steps = listWorkItems(db).filter((w) => w.kind === "item");
    const first = steps[0];
    const { row, html } = seen(request.id);
    expect(row.delivery?.state).toBe("needs-attention");
    expect(row.delivery?.attention?.id).toBe(first?.id);
    expect(row.delivery?.attention?.action).toBe("retry");
    expect(html).toContain(`data-action="retry" data-id="${first?.id}"`);
    expect(first?.status).toBe("failed");
    const others = listWorkItems(db).filter((w) => w.id !== request.id && w.id !== first?.id);
    expect(others).toHaveLength(2);
    expect(others.map((w) => w.status)).toEqual(["queued", "queued"]);

    failImplementer = false;
    const retry = handleApi(db, { method: "POST", path: `/api/items/${first?.id}/retry`, body: undefined });
    expect(retry.status).toBe(200);
    await settle(daemon);

    expect(seen(request.id).row.delivery?.state).toBe("delivered");
  }, 60_000);

  it("builds the work the first verification found missing, then passes the second", async () => {
    const calls: Call[] = [];
    const daemon = makeDaemon(
      fakeQuery(calls, (call, nth, cwd) => {
        if (call.role === "planner") return [planResult("two steps", [planItem("one"), planItem("two", ["one"])])];
        if (call.role === "verifier") {
          return [nth === 1 ? planResult("one thing is missing", [planItem("three")]) : planResult("done", [])];
        }
        if (call.role === "review") return [result({ structured_output: { verdict: "approve", findings: [] } })];
        commitFile(cwd, `impl-${nth}.txt`);
        return [result()];
      }),
    );
    const request = addWorkItem(db, { title: "Build the thing", contents: "Please build the thing.", kind: "request" });
    await settle(daemon);

    const items = listWorkItems(db);
    expect(items.map((w) => w.status)).toEqual(items.map(() => "done"));
    expect(items.filter((w) => w.kind === "item")).toHaveLength(3);
    expect(items.filter((w) => w.kind === "verify")).toHaveLength(2);
    expect(calls.filter((c) => c.role === "verifier")).toHaveLength(2);
    expect(calls.filter((c) => c.role === "implement")).toHaveLength(3);
    expect(getWorkItem(db, request.id).status).toBe("done");
    expect(sh(root, "status", "--porcelain")).toBe("");
  }, 60_000);

  it("fails the third pass when the verifier always finds missing work", async () => {
    const calls: Call[] = [];
    const daemon = makeDaemon(
      fakeQuery(calls, (call, nth, cwd) => {
        if (call.role === "planner") return [planResult("two steps", [planItem("one"), planItem("two", ["one"])])];
        if (call.role === "verifier") return [planResult("more missing", [planItem(`more-${nth}`)])];
        if (call.role === "review") return [result({ structured_output: { verdict: "approve", findings: [] } })];
        commitFile(cwd, `impl-${nth}.txt`);
        return [result()];
      }),
    );
    const request = addWorkItem(db, { title: "Build the thing", contents: "Please build the thing.", kind: "request" });
    await settle(daemon);

    const { row, html } = seen(request.id);
    expect(row.delivery?.state).toBe("incomplete");
    expect(row.delivery?.attention?.action).toBe("ask-again");
    expect(html).toContain("Ask for the rest");
    expect(html).not.toContain('data-action="retry"');
    expect(getWorkItem(db, request.id).status).toBe("done");

    const verifies = listWorkItems(db).filter((w) => w.kind === "verify");
    expect(verifies.map((w) => w.status)).toEqual(["done", "failed"]);
    expect(verifies[1]?.error).toContain("maxVerifyRounds");
    expect(calls.filter((c) => c.role === "verifier")).toHaveLength(2);
    expect(listWorkItems(db).filter((w) => w.status === "queued")).toEqual([]);
    expect(listWorkItems(db).filter((w) => w.kind === "verify")).toHaveLength(2);
  }, 60_000);
});
