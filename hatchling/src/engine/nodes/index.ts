import { query } from "@anthropic-ai/claude-agent-sdk";
import { createAgentNode, createReviewNode } from "./agent.ts";
import { branchNode } from "./branch.ts";
import { checksNode } from "./checks.ts";
import { mergeNode } from "./merge.ts";
import type { NodeRegistry } from "./types.ts";

export const builtinNodeTypes: NodeRegistry = {
  agent: createAgentNode({ query }),
  branch: branchNode,
  checks: checksNode,
  merge: mergeNode,
  review: createReviewNode({ query }),
};
