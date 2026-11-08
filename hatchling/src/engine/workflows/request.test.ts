import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtinNodeTypes } from "../nodes/index.ts";
import { loadWorkflows } from "./load.ts";
import type { Workflow } from "./schema.ts";

const hatchlingRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function shipped(id: string): Workflow {
  const workflow = loadWorkflows(join(hatchlingRoot, "workflows"), builtinNodeTypes).find((w) => w.id === id);
  if (!workflow) throw new Error(`${id} workflow not found`);
  return workflow;
}

const cases = [
  { id: "request", kind: "request", start: "plan", nodes: ["plan", "enqueue"], prompt: "plan", role: "planner" },
  { id: "verify", kind: "verify", start: "verify", nodes: ["verify", "enqueue"], prompt: "verify", role: "verifier" },
];

describe.each(cases)("the shipped $id workflow", ({ id, kind, start, nodes, prompt, role }) => {
  it("loads through the loader", () => {
    const workflow = shipped(id);
    expect(workflow.trigger).toEqual({ type: "queue", kind });
    expect(workflow.start).toBe(start);
    expect(workflow.nodes.map((n) => n.id)).toEqual(nodes);
  });

  it("has no loop: no edge closes a cycle", () => {
    const { edges } = shipped(id);
    const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return edges.filter((e) => e.from === from).some((e) => reaches(e.to, target, seen));
    };
    expect(edges.filter((e) => reaches(e.to, e.from))).toEqual([]);
  });

  it("keeps the agent node read-only in the main checkout", () => {
    const node = shipped(id).nodes.find((n) => n.id === start);
    const config = node?.config as {
      cwd: string;
      output: string;
      commit?: boolean;
      tools: string[];
      bash: string[];
    };
    expect(config.cwd).toBe("root");
    expect(config.output).toBe("plan");
    expect(config.commit ?? false).toBe(false);
    for (const tool of ["Write", "Edit", "NotebookEdit"]) expect(config.tools).not.toContain(tool);
    for (const pattern of config.bash) expect(pattern).toMatch(/^(git (log|show|diff|status)\*|ls \*)$/);
  });

  it("has a prompt that begins with its role", () => {
    const file = join(hatchlingRoot, "prompts", `${prompt}.md`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").startsWith(`# Role: ${role}`)).toBe(true);
  });
});
