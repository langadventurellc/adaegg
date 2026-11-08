import { z } from "zod";

export const PlanItemSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1).max(120),
  contents: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
});

export const PlanSchema = z
  .object({
    summary: z.string().default(""),
    items: z.array(PlanItemSchema).max(8),
  })
  .superRefine((plan, ctx) => {
    const earlier = new Set<string>();
    for (const item of plan.items) {
      if (earlier.has(item.key)) {
        ctx.addIssue({ code: "custom", path: ["items"], message: `duplicate key "${item.key}"` });
      }
      for (const dep of item.dependsOn) {
        if (!earlier.has(dep)) {
          ctx.addIssue({
            code: "custom",
            path: ["items"],
            message: `item "${item.key}" depends on "${dep}", which is not an earlier item`,
          });
        }
      }
      earlier.add(item.key);
    }
  });

export type PlanItem = z.infer<typeof PlanItemSchema>;
export type Plan = z.infer<typeof PlanSchema>;

// Plain JSON schema for the SDK's `outputFormat`; Zod enforces the limits.
export const PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          contents: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
        },
        required: ["key", "title", "contents", "dependsOn"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "items"],
  additionalProperties: false,
};
