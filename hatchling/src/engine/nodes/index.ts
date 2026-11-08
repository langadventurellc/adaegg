import { branchNode } from "./branch.ts";
import { checksNode } from "./checks.ts";
import { mergeNode } from "./merge.ts";
import type { NodeRegistry } from "./types.ts";

export const builtinNodeTypes: NodeRegistry = {
  branch: branchNode,
  checks: checksNode,
  merge: mergeNode,
};
