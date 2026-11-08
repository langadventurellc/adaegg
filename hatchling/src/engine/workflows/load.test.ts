import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode, type NodeRegistry, RunStateSchema } from "../nodes/types.ts";
import { loadWorkflows, validateWorkflow } from "./load.ts";

const nodeTypes: NodeRegistry = {
  branch: defineNode({
    type: "branch",
    outcomes: ["ok", "fail"],
    configSchema: z.object({}),
    run: async () => ({ outcome: "ok" }),
  }),
  checks: defineNode({
    type: "checks",
    outcomes: ["passed", "failed"],
    configSchema: z.object({ command: z.string().optional() }),
    run: async () => ({ outcome: "passed" }),
  }),
};

const valid = `
id: example
name: Example
trigger: { type: queue, kind: item }
start: branch
nodes:
  - { id: branch, type: branch }
  - { id: checks, type: checks }
edges:
  - { from: branch, on: ok, to: checks }
  - { from: branch, on: fail, to: fail }
  - { from: checks, on: passed, to: end }
  - { from: checks, on: failed, to: branch, max: 2 }
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adaegg-workflows-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function problemsOf(yamlText: string): string[] {
  const dirCase = mkdtempSync(join(tmpdir(), "adaegg-workflows-case-"));
  try {
    writeFileSync(join(dirCase, "w.yaml"), yamlText);
    loadWorkflows(dirCase, nodeTypes);
    return [];
  } catch (err) {
    return (err as Error).message.split("\n").filter((l) => l.startsWith("  - "));
  } finally {
    rmSync(dirCase, { recursive: true, force: true });
  }
}

describe("loadWorkflows", () => {
  it("loads a valid file", () => {
    writeFileSync(join(dir, "example.yaml"), valid);
    const [workflow, ...rest] = loadWorkflows(dir, nodeTypes);
    expect(rest).toEqual([]);
    expect(workflow?.id).toBe("example");
    expect(workflow?.nodes[0]?.config).toEqual({});
    expect(workflow?.edges[3]?.max).toBe(2);
  });

  it("returns an empty list for an empty or missing dir", () => {
    expect(loadWorkflows(dir, nodeTypes)).toEqual([]);
    expect(loadWorkflows(join(dir, "missing"), nodeTypes)).toEqual([]);
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    expect(loadWorkflows(dir, nodeTypes)).toEqual([]);
  });

  it("rejects a duplicate node id", () => {
    const problems = problemsOf(valid.replace("- { id: checks, type: checks }", "- { id: branch, type: checks }"));
    expect(problems).toContain("  - duplicate node id 'branch'");
  });

  it("rejects a missing start", () => {
    expect(problemsOf(valid.replace("start: branch", "start: nope"))).toContain("  - start node 'nope' does not exist");
  });

  it("rejects an unknown target", () => {
    expect(problemsOf(valid.replace("to: branch, max: 2", "to: nowhere, max: 2"))).toContain(
      "  - edge checks:failed -> nowhere: unknown target",
    );
  });

  it("rejects an unknown from", () => {
    expect(problemsOf(`${valid}  - { from: ghost, on: ok, to: end }\n`)).toContain(
      "  - edge ghost:ok -> end: unknown source node 'ghost'",
    );
  });

  it("rejects a duplicate (from, on)", () => {
    expect(problemsOf(`${valid}  - { from: branch, on: ok, to: end }\n`)).toContain(
      "  - duplicate edge for 'branch:ok'",
    );
  });

  it("rejects an outcome the node does not declare", () => {
    expect(problemsOf(`${valid}  - { from: branch, on: weird, to: end }\n`)).toContain(
      "  - edge branch:weird -> end: node 'branch' (branch) does not declare outcome 'weird'",
    );
  });

  it("rejects a declared outcome with no edge", () => {
    expect(problemsOf(valid.replace("  - { from: branch, on: fail, to: fail }\n", ""))).toContain(
      "  - node 'branch' (branch) declares outcome 'fail' but has no edge for it",
    );
  });

  it("rejects a bad node config", () => {
    const problems = problemsOf(
      valid.replace("{ id: checks, type: checks }", "{ id: checks, type: checks, config: { command: 5 } }"),
    );
    expect(problems.some((p) => p.startsWith("  - node 'checks' (checks) has invalid config.command"))).toBe(true);
  });

  it("rejects an unknown node type", () => {
    expect(problemsOf(valid.replace("type: checks }", "type: mystery }"))).toContain(
      "  - node 'checks' has unknown type 'mystery'",
    );
  });

  it("rejects an unknown trigger type", () => {
    expect(problemsOf(valid.replace("type: queue", "type: webhook"))).toContain(
      "  - unknown trigger type 'webhook' (supported: 'queue', 'cron')",
    );
  });

  const cronWorkflow = valid.replace(
    "trigger: { type: queue, kind: item }",
    'trigger: { type: cron, schedule: "17 3 * * *" }',
  );

  it("loads a cron workflow", () => {
    writeFileSync(join(dir, "c.yaml"), cronWorkflow);
    const [workflow] = loadWorkflows(dir, nodeTypes);
    expect(workflow?.trigger).toEqual({ type: "cron", schedule: "17 3 * * *" });
  });

  it("reports a bad schedule with the field", () => {
    writeFileSync(join(dir, "c.yaml"), cronWorkflow.replace("17 3 * * *", "60 * * * *"));
    expect(() => loadWorkflows(dir, nodeTypes)).toThrow(/c\.yaml:\n {2}- trigger\.schedule: .*minute/);
  });

  it("rejects a schedule that never runs", () => {
    const problems = problemsOf(cronWorkflow.replace("17 3 * * *", "0 0 31 2 *"));
    expect(problems.some((p) => p.includes("never runs"))).toBe(true);
  });

  it("rejects a cron workflow whose id equals a queue workflow's kind", () => {
    writeFileSync(join(dir, "a.yaml"), valid);
    writeFileSync(join(dir, "b.yaml"), cronWorkflow.replace("id: example", "id: item"));
    expect(() => loadWorkflows(dir, nodeTypes)).toThrow(/b\.yaml:\n {2}- cron workflow id 'item' equals the kind/);
  });

  it("rejects a non-positive max", () => {
    expect(problemsOf(valid.replace("max: 2", "max: 0")).length).toBeGreaterThan(0);
  });

  it("names the file for invalid YAML", () => {
    writeFileSync(join(dir, "bad.yaml"), "a: [unclosed");
    expect(() => loadWorkflows(dir, nodeTypes)).toThrow(/bad\.yaml:\n {2}- invalid YAML/);
  });

  it("reports every problem in one file", () => {
    const problems = problemsOf(valid.replace("start: branch", "start: nope").replace("type: queue", "type: webhook"));
    expect(problems).toHaveLength(2);
  });

  it("reports problems from several files with their names", () => {
    writeFileSync(join(dir, "a.yaml"), valid.replace("start: branch", "start: nope"));
    writeFileSync(
      join(dir, "b.yaml"),
      valid.replace("id: example", "id: other").replace("type: queue", "type: webhook"),
    );
    let message = "";
    try {
      loadWorkflows(dir, nodeTypes);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`${join(dir, "a.yaml")}:`);
    expect(message).toContain("start node 'nope' does not exist");
    expect(message).toContain(`${join(dir, "b.yaml")}:`);
    expect(message).toContain("unknown trigger type 'webhook'");
  });

  it("rejects duplicate workflow ids across files", () => {
    writeFileSync(join(dir, "a.yaml"), valid);
    writeFileSync(join(dir, "b.yaml"), valid);
    expect(() => loadWorkflows(dir, nodeTypes)).toThrow(/b\.yaml:\n {2}- duplicate workflow id 'example'/);
  });
});

describe("validateWorkflow", () => {
  it("reports schema problems for a non-object", () => {
    expect(validateWorkflow("nope", nodeTypes).problems.length).toBeGreaterThan(0);
  });
});

describe("RunStateSchema", () => {
  it("fills defaults from an empty object", () => {
    expect(RunStateSchema.parse({})).toEqual({
      base: null,
      branch: null,
      worktree: null,
      edgeCounts: {},
      checkOutput: "",
      checkedCommit: null,
      findings: [],
      conflictFiles: [],
      mergeCommit: null,
      changedPaths: [],
      problem: null,
      plan: null,
    });
  });
});
