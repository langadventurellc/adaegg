import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtinNodeTypes } from "../nodes/index.ts";
import { loadWorkflows } from "./load.ts";
import type { Workflow } from "./schema.ts";

const hatchlingRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function implementWorkflow(): Workflow {
  const workflow = loadWorkflows(join(hatchlingRoot, "workflows"), builtinNodeTypes).find((w) => w.id === "implement");
  if (!workflow) throw new Error("implement workflow not found");
  return workflow;
}

describe("the shipped implement workflow", () => {
  it("loads through the loader", () => {
    const workflow = implementWorkflow();
    expect(workflow.trigger).toEqual({ type: "queue", kind: "item" });
    expect(workflow.start).toBe("branch");
    expect(workflow.nodes.map((n) => n.id)).toEqual(["branch", "implement", "checks", "review", "merge"]);
  });

  it("bounds every loop: the edges without a max form no cycle", () => {
    const { edges } = implementWorkflow();
    const unbounded = edges.filter((e) => e.max === undefined);
    // An edge a -> b closes a loop when b can reach a again through unbounded edges.
    const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return unbounded.filter((e) => e.from === from).some((e) => reaches(e.to, target, seen));
    };
    expect(unbounded.filter((e) => reaches(e.to, e.from))).toEqual([]);
    expect(edges.length - unbounded.length).toBeGreaterThan(0);
  });

  it("rejects verdict output on a plain agent node when loading", () => {
    const dir = mkdtempSync(join(tmpdir(), "adaegg-verdict-"));
    try {
      const shipped = readFileSync(join(hatchlingRoot, "workflows", "implement.yaml"), "utf8");
      const broken = shipped.replace("      commit: true\n", "      commit: true\n      output: verdict\n");
      expect(broken).not.toBe(shipped);
      writeFileSync(join(dir, "implement.yaml"), broken);
      expect(() => loadWorkflows(dir, builtinNodeTypes)).toThrow(/verdict/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has non-empty prompt files for its agent nodes", () => {
    for (const node of implementWorkflow().nodes.filter((n) => n.type === "agent" || n.type === "review")) {
      const prompt = (node.config as { prompt: string }).prompt;
      expect(readFileSync(join(hatchlingRoot, prompt), "utf8").trim().length, prompt).toBeGreaterThan(0);
    }
  });
});
