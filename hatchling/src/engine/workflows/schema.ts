import { z } from "zod";

export const WorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  trigger: z.object({ type: z.string(), kind: z.string().min(1) }),
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
