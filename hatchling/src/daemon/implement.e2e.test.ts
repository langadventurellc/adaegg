import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import { AUTH_PROBLEM, createAgentNode, createReviewNode, type QueryFn } from "../engine/nodes/agent.ts";
import { builtinNodeTypes } from "../engine/nodes/index.ts";
import { buildTemplateRepo, copyRepo, removeAllRepos, removeCopies, sh } from "../engine/nodes/test-repo.ts";
import type { NodeRegistry } from "../engine/nodes/types.ts";
import { listNodeRuns, listRuns } from "../engine/runs.ts";
import { addWorkItem, getWorkItem } from "../engine/store.ts";
import { loadWorkflows } from "../engine/workflows/load.ts";
import { createDaemon, type Daemon } from "./daemon.ts";

const hatchlingRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Fails until the marker file is committed.
const MARKER_CHECK = 'test -f .ok || { echo "missing .ok marker"; exit 1; }';

let template: string;
beforeAll(() => {
  template = buildTemplateRepo();
  cpSync(join(hatchlingRoot, "workflows"), join(template, "workflows"), { recursive: true });
  cpSync(join(hatchlingRoot, "prompts"), join(template, "prompts"), { recursive: true });
  sh(template, "add", "-A");
  sh(template, "commit", "-m", "add the shipped workflow and prompts");
});

type Msg = Record<string, unknown>;
type Role = "implement" | "review";
type Call = { role: Role; prompt: string };

const result = (extra: Msg = {}): Msg => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  total_cost_usd: 0.1,
  usage: { input_tokens: 10, output_tokens: 5 },
  ...extra,
});

const verdict = (v: "approve" | "changes", findings: string[] = []): Msg =>
  result({ structured_output: { verdict: v, findings } });

// Fake `query`: tells the role from the prompt, records every call, and lets `script` act and answer.
function fakeQuery(calls: Call[], script: (call: Call, nth: number, cwd: string) => Msg[]): QueryFn {
  return ((params: { prompt: string; options: { cwd: string } }) => {
    const role: Role = params.prompt.startsWith("# Role: reviewer") ? "review" : "implement";
    const call = { role, prompt: params.prompt };
    calls.push(call);
    const nth = calls.filter((c) => c.role === role).length;
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

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting");
}

let root: string;
let db: DatabaseSync;
let daemons: Daemon[];
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

// Writes and commits adaegg.json in the repo, then starts a daemon on the real workflow with the fake.
function makeDaemon(checks: string, query: QueryFn): Daemon {
  writeFileSync(join(root, "adaegg.json"), `${JSON.stringify({ schema: 1, setup: "", checks })}\n`);
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

async function runItem(daemon: Daemon, title = "Add the feature") {
  const item = addWorkItem(db, { title, contents: "Please add the feature." });
  await daemon.tick();
  await waitFor(() => getWorkItem(db, item.id).status !== "in_progress");
  const [run] = listRuns(db);
  const nodes = listNodeRuns(db, (run as { id: string }).id).map((n) => [n.nodeId, n.outcome]);
  return { item, run: run as NonNullable<typeof run>, nodes };
}

describe("implement workflow end to end", () => {
  it("takes an item through implement, checks and review to a merge on main", async () => {
    const calls: Call[] = [];
    const daemon = makeDaemon(
      "true",
      fakeQuery(calls, (call, _nth, cwd) => {
        if (call.role === "review") return [verdict("approve")];
        commitFile(cwd, "feature.txt");
        return [result()];
      }),
    );
    const { item, run, nodes } = await runItem(daemon);

    expect(getWorkItem(db, item.id).status).toBe("done");
    expect(run.status).toBe("succeeded");
    expect(readFileSync(join(root, "feature.txt"), "utf8")).toBe("feature.txt\n");
    expect(sh(root, "branch", "--contains", sh(root, "log", "-1", "--format=%H", "--", "feature.txt"))).toContain(
      "main",
    );
    expect(nodes).toEqual([
      ["branch", "ok"],
      ["implement", "done"],
      ["checks", "passed"],
      ["review", "approve"],
      ["merge", "merged"],
    ]);
    expect(calls[0]?.prompt).toContain(`Work item id: ${item.id}`);
    expect(calls[0]?.prompt).toContain("Base branch: main");
  });

  it("sends a failing check back to implement once, then passes", async () => {
    const calls: Call[] = [];
    const daemon = makeDaemon(
      MARKER_CHECK,
      fakeQuery(calls, (call, nth, cwd) => {
        if (call.role === "review") return [verdict("approve")];
        commitFile(cwd, nth === 1 ? "feature.txt" : ".ok");
        return [result()];
      }),
    );
    const { item, run, nodes } = await runItem(daemon);

    expect(getWorkItem(db, item.id).status).toBe("done");
    expect(nodes.map(([n, o]) => `${n}:${o}`)).toEqual([
      "branch:ok",
      "implement:done",
      "checks:failed",
      "implement:done",
      "checks:passed",
      "review:approve",
      "merge:merged",
    ]);
    expect(run.state.edgeCounts["checks:failed"]).toBe(1);
    const second = calls.filter((c) => c.role === "implement")[1];
    expect(second?.prompt).toContain("# Check output");
    expect(second?.prompt).toContain("missing .ok marker");
    expect(existsSync(join(root, ".ok"))).toBe(true);
  });

  it("sends a changes verdict back to implement with the findings in the next prompt", async () => {
    const calls: Call[] = [];
    const daemon = makeDaemon(
      "true",
      fakeQuery(calls, (call, nth, cwd) => {
        if (call.role === "review") {
          return [nth === 1 ? verdict("changes", ["Add a test for the feature"]) : verdict("approve")];
        }
        commitFile(cwd, nth === 1 ? "feature.txt" : "feature.test.txt");
        return [result()];
      }),
    );
    const { item, nodes } = await runItem(daemon);

    expect(getWorkItem(db, item.id).status).toBe("done");
    expect(nodes.map(([n, o]) => `${n}:${o}`)).toEqual([
      "branch:ok",
      "implement:done",
      "checks:passed",
      "review:changes",
      "implement:done",
      "checks:passed",
      "review:approve",
      "merge:merged",
    ]);
    const implementCalls = calls.filter((c) => c.role === "implement");
    expect(implementCalls[0]?.prompt).not.toContain("# Review findings");
    expect(implementCalls[1]?.prompt).toContain("# Review findings\n\n- Add a test for the feature");
    expect(existsSync(join(root, "feature.test.txt"))).toBe(true);
  });

  it("fails the run when checks fail a third time", async () => {
    const calls: Call[] = [];
    const daemon = makeDaemon(
      MARKER_CHECK,
      fakeQuery(calls, (call, nth, cwd) => {
        if (call.role === "review") return [verdict("approve")];
        commitFile(cwd, `attempt-${nth}.txt`);
        return [result()];
      }),
    );
    const { item, run, nodes } = await runItem(daemon);

    expect(run.status).toBe("failed");
    expect(run.error).toBe("loop checks:failed exceeded its limit of 2");
    expect(getWorkItem(db, item.id).status).toBe("failed");
    expect(nodes.filter(([n]) => n === "implement")).toHaveLength(3);
    expect(calls.some((c) => c.role === "review")).toBe(false);
    expect(existsSync(join(root, "attempt-1.txt"))).toBe(false);
  });

  it("fails the run with the sign-in guidance on an auth error", async () => {
    const calls: Call[] = [];
    const daemon = makeDaemon(
      "true",
      fakeQuery(calls, () => [
        { type: "assistant", error: "authentication_failed", message: { content: [] } },
        result({ subtype: "success", is_error: true, result: "Invalid API key" }),
      ]),
    );
    const { item, run, nodes } = await runItem(daemon);

    expect(run.status).toBe("failed");
    expect(run.error).toBe(AUTH_PROBLEM);
    expect(getWorkItem(db, item.id).status).toBe("failed");
    expect(nodes).toEqual([
      ["branch", "ok"],
      ["implement", "blocked"],
    ]);
  });
});
