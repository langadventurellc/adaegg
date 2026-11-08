import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextRun, parseCron } from "../cron.ts";
import { builtinNodeTypes } from "../nodes/index.ts";
import { loadWorkflows } from "./load.ts";
import type { Workflow } from "./schema.ts";

const hatchlingRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function shipped(id: string): Workflow {
  const workflow = loadWorkflows(join(hatchlingRoot, "workflows"), builtinNodeTypes).find((w) => w.id === id);
  if (!workflow) throw new Error(`${id} workflow not found`);
  return workflow;
}

describe("the shipped tidy workflow", () => {
  it("loads through the loader", () => {
    const workflow = shipped("tidy");
    expect(workflow.trigger).toEqual({ type: "cron", schedule: "17 3 * * *" });
    expect(workflow.start).toBe("tidy");
    expect(workflow.nodes).toEqual([{ id: "tidy", type: "tidy", config: { retainLogDays: 30 } }]);
    expect(workflow.edges).toEqual([
      { from: "tidy", on: "tidied", to: "end" },
      { from: "tidy", on: "failed", to: "fail" },
    ]);
  });

  it("fires once a day", () => {
    const { trigger } = shipped("tidy");
    if (trigger.type !== "cron") throw new Error("not a cron trigger");
    const schedule = parseCron(trigger.schedule);
    const first = nextRun(schedule, new Date(2026, 5, 10, 12, 0));
    expect(first).not.toBeNull();
    const second = nextRun(schedule, first as Date);
    expect((second as Date).getTime() - (first as Date).getTime()).toBe(24 * 3600_000);
  });
});
