import { z } from "zod";
import { addWorkItem, getWorkItem, hasItemsFromSource, inTransaction } from "../store.ts";
import { defineNode } from "./types.ts";

const TITLE_LIMIT = 100;

export const enqueueNode = defineNode({
  type: "enqueue",
  outcomes: ["queued", "failed"],
  configSchema: z.object({ maxVerifyRounds: z.number().int().positive().default(2) }),
  async run(ctx) {
    const { maxVerifyRounds } = ctx.config;
    return inTransaction(ctx.db, () => {
      const self = ctx.workItem;
      if (self.kind !== "request" && self.kind !== "verify") {
        return { outcome: "failed", problem: `enqueue needs a request or verify work item, got kind ${self.kind}` };
      }
      if (self.kind === "verify" && !self.parentId) {
        return { outcome: "failed", problem: "verify item has no parent request" };
      }
      const root = getWorkItem(ctx.db, self.kind === "request" ? self.id : (self.parentId as string));

      if (hasItemsFromSource(ctx.db, self.id)) return { outcome: "queued" };

      const plan = ctx.state.plan;
      if (!plan) return { outcome: "failed", problem: "no plan in the run state" };
      if (plan.items.length === 0) {
        if (self.kind === "request") {
          return { outcome: "failed", problem: `the planner found nothing to build: ${plan.summary}` };
        }
        return { outcome: "queued" };
      }

      const verifies = ctx.db
        .prepare("SELECT COUNT(*) AS n FROM work_items WHERE kind = 'verify' AND parent_id = ?")
        .get(root.id);
      const round = Number(verifies?.n ?? 0) + 1;
      const queuesVerification = self.kind === "request" ? plan.items.length >= 2 : plan.items.length >= 1;
      if (queuesVerification && round > maxVerifyRounds) {
        const wanted = plan.items.map((item) => `"${item.title}"`).join(", ");
        return {
          outcome: "failed",
          problem:
            `the request still has missing work after ${maxVerifyRounds} verification rounds (maxVerifyRounds). ` +
            `The verifier wanted: ${wanted}. Look at it with hatch show ${root.id.slice(0, 8)} and decide.`,
        };
      }

      const rootId8 = root.id.slice(0, 8);
      const created = new Map<string, { id: string; title: string }>();
      for (const planItem of plan.items) {
        const item = addWorkItem(ctx.db, {
          title: planItem.title,
          contents: `Part of the request ${rootId8} "${root.title}".\n\n${planItem.contents}`,
          kind: "item",
          priority: self.priority,
          parentId: root.id,
          sourceId: self.id,
          blockedBy: planItem.dependsOn.map((key) => (created.get(key) as { id: string }).id),
        });
        created.set(planItem.key, { id: item.id, title: item.title });
      }

      if (queuesVerification) {
        const list = [...created.values()].map((item, i) => `${i + 1}. ${item.id.slice(0, 8)} ${item.title}`);
        addWorkItem(ctx.db, {
          title: `Verify: ${root.title}`.slice(0, TITLE_LIMIT),
          contents: [
            `Original request: ${root.title}`,
            "",
            root.contents,
            "",
            "Items built for it:",
            ...list,
            "",
            `Round ${round} of ${maxVerifyRounds}`,
            "",
            "Check the code against the request and list only the work that is still missing.",
          ].join("\n"),
          kind: "verify",
          priority: self.priority,
          parentId: root.id,
          sourceId: self.id,
          blockedBy: [...created.values()].map((item) => item.id),
        });
      }
      return { outcome: "queued" };
    });
  },
});
