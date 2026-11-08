import { query } from "@anthropic-ai/claude-agent-sdk";
import { createAgentNode, createReviewNode } from "./agent.ts";
import { branchNode } from "./branch.ts";
import { checksNode } from "./checks.ts";
import { enqueueNode } from "./enqueue.ts";
import { mergeNode } from "./merge.ts";
import { tidyNode } from "./tidy.ts";
import type { NodeRegistry } from "./types.ts";

export const builtinNodeTypes: NodeRegistry = {
  agent: createAgentNode({ query }),
  branch: branchNode,
  checks: checksNode,
  enqueue: enqueueNode,
  merge: mergeNode,
  review: createReviewNode({ query }),
  tidy: tidyNode,
};
