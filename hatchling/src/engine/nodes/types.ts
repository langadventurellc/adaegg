import { z } from "zod";
import type { Config } from "../config.ts";
import type { WorkItem } from "../store.ts";

// The run's JSON state. Nodes talk to each other only through it.
export const RunStateSchema = z.object({
  base: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  worktree: z.string().nullable().default(null),
  // How often each edge was taken in this run, keyed `from:on`.
  edgeCounts: z.record(z.string(), z.number()).default({}),
  checkOutput: z.string().default(""),
  // The branch tip the last passing checks ran on.
  checkedCommit: z.string().nullable().default(null),
  // Review findings as plain strings, one finding each.
  findings: z.array(z.string()).default([]),
  conflictFiles: z.array(z.string()).default([]),
  mergeCommit: z.string().nullable().default(null),
  changedPaths: z.array(z.string()).default([]),
  problem: z.string().nullable().default(null),
});

export type RunState = z.infer<typeof RunStateSchema>;

export type NodeResult = {
  outcome: string;
  problem?: string;
  // A patch merged shallowly into the run state.
  state?: Partial<RunState>;
  costUsd?: number;
  tokens?: { input: number; output: number };
};

export type NodeContext<C> = {
  workItem: WorkItem;
  runId: string;
  // The id of this node in the workflow.
  nodeId: string;
  // Which attempt of this node in the run this is, starting at 1.
  attempt: number;
  state: RunState;
  config: C;
  paths: { root: string; stateDir: string };
  appConfig: Config;
  signal: AbortSignal;
  now(): Date;
};

export type NodeType<C> = {
  type: string;
  outcomes: readonly string[];
  configSchema: z.ZodType<C>;
  run(ctx: NodeContext<C>): Promise<NodeResult>;
};

export type AnyNodeType = NodeType<unknown>;

export type NodeRegistry = Record<string, AnyNodeType>;

// The loader validates a node's config with its own schema before the runner
// calls `run`, so widening `C` to `unknown` here is safe.
export function defineNode<C>(node: NodeType<C>): AnyNodeType {
  return node as unknown as AnyNodeType;
}
