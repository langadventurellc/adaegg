import { z } from "zod";

export const WorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  trigger: z.discriminatedUnion("type", [
    z.object({ type: z.literal("queue"), kind: z.string().min(1) }),
    z.object({ type: z.literal("cron"), schedule: z.string().min(1) }),
  ]),
  start: z.string().min(1),
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      type: z.string().min(1),
      config: z.unknown().default({}),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string().min(1),
      on: z.string().min(1),
      to: z.string().min(1),
      max: z.number().int().positive().optional(),
    }),
  ),
});

export type Workflow = z.infer<typeof WorkflowSchema>;

// The kind of work item a workflow claims. A cron workflow's items have its own id as kind, so only it claims them.
export function workflowKind(workflow: Workflow): string {
  return workflow.trigger.type === "queue" ? workflow.trigger.kind : workflow.id;
}
