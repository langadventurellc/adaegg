import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { nextRun, parseCron } from "../cron.ts";
import type { NodeRegistry } from "../nodes/types.ts";
import { type Workflow, WorkflowSchema } from "./schema.ts";

const TERMINALS = ["end", "fail"];
const TRIGGER_TYPES = ["queue", "cron"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateWorkflow(raw: unknown, nodeTypes: NodeRegistry): { workflow?: Workflow; problems: string[] } {
  const problems: string[] = [];
  // An unknown trigger type would only fail the union with a generic message: report it readably, then parse the rest
  // with a stand-in trigger so the other problems in the file still show.
  let candidate = raw;
  const rawTrigger = isRecord(raw) ? raw.trigger : undefined;
  if (isRecord(rawTrigger) && typeof rawTrigger.type === "string" && !TRIGGER_TYPES.includes(rawTrigger.type)) {
    problems.push(`unknown trigger type '${rawTrigger.type}' (supported: 'queue', 'cron')`);
    candidate = { ...(raw as Record<string, unknown>), trigger: { type: "queue", kind: "unknown" } };
  }
  const parsed = WorkflowSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      problems: [
        ...problems,
        ...parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
      ],
    };
  }
  const workflow = parsed.data;

  if (workflow.trigger.type === "cron") {
    try {
      const schedule = parseCron(workflow.trigger.schedule);
      if (nextRun(schedule, new Date()) === null) {
        problems.push(`trigger.schedule '${workflow.trigger.schedule}' never runs`);
      }
    } catch (err) {
      problems.push(`trigger.schedule: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const types = new Map<string, string>();
  for (const node of workflow.nodes) {
    if (types.has(node.id)) {
      problems.push(`duplicate node id '${node.id}'`);
      continue;
    }
    types.set(node.id, node.type);
    const nodeType = Object.hasOwn(nodeTypes, node.type) ? nodeTypes[node.type] : undefined;
    if (!nodeType) {
      problems.push(`node '${node.id}' has unknown type '${node.type}'`);
      continue;
    }
    const config = nodeType.configSchema.safeParse(node.config);
    if (!config.success) {
      for (const issue of config.error.issues) {
        const where = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
        problems.push(`node '${node.id}' (${node.type}) has invalid config${where}: ${issue.message}`);
      }
    }
  }

  if (!types.has(workflow.start)) {
    problems.push(`start node '${workflow.start}' does not exist`);
  }

  const seen = new Set<string>();
  const handled = new Set<string>();
  for (const edge of workflow.edges) {
    const label = `${edge.from}:${edge.on} -> ${edge.to}`;
    const fromType = types.get(edge.from);
    if (fromType === undefined) {
      problems.push(`edge ${label}: unknown source node '${edge.from}'`);
    }
    if (!types.has(edge.to) && !TERMINALS.includes(edge.to)) {
      problems.push(`edge ${label}: unknown target`);
    }
    const key = `${edge.from}:${edge.on}`;
    if (seen.has(key)) {
      problems.push(`duplicate edge for '${key}'`);
    }
    seen.add(key);
    handled.add(key);
    const nodeType = fromType !== undefined && Object.hasOwn(nodeTypes, fromType) ? nodeTypes[fromType] : undefined;
    if (nodeType && !nodeType.outcomes.includes(edge.on)) {
      problems.push(`edge ${label}: node '${edge.from}' (${fromType}) does not declare outcome '${edge.on}'`);
    }
  }

  for (const node of workflow.nodes) {
    const nodeType = Object.hasOwn(nodeTypes, node.type) ? nodeTypes[node.type] : undefined;
    if (!nodeType || types.get(node.id) !== node.type) continue;
    for (const outcome of nodeType.outcomes) {
      if (!handled.has(`${node.id}:${outcome}`)) {
        problems.push(`node '${node.id}' (${node.type}) declares outcome '${outcome}' but has no edge for it`);
      }
    }
  }

  return problems.length > 0 ? { problems } : { workflow, problems };
}

export function loadWorkflows(dir: string, nodeTypes: NodeRegistry): Workflow[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const workflows: Workflow[] = [];
  const errors: string[] = [];
  const idFiles = new Map<string, string>();

  for (const name of files) {
    const file = join(dir, name);
    let raw: unknown;
    try {
      raw = parse(readFileSync(file, "utf8"));
    } catch (err) {
      errors.push(`${file}:\n  - invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const { workflow, problems } = validateWorkflow(raw, nodeTypes);
    if (workflow) {
      const first = idFiles.get(workflow.id);
      if (first !== undefined) {
        problems.push(`duplicate workflow id '${workflow.id}' (also in ${first})`);
      } else {
        idFiles.set(workflow.id, file);
      }
    }
    if (problems.length > 0) {
      errors.push(`${file}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    } else if (workflow) {
      workflows.push(workflow);
    }
  }

  // A cron workflow claims items of kind = its id, so an id equal to a queue workflow's kind would steal that queue.
  const queueKinds = new Set(workflows.flatMap((w) => (w.trigger.type === "queue" ? [w.trigger.kind] : [])));
  for (const w of workflows) {
    if (w.trigger.type === "cron" && queueKinds.has(w.id)) {
      errors.push(
        `${idFiles.get(w.id)}:\n  - cron workflow id '${w.id}' equals the kind of a queue workflow (it would steal that queue); rename the workflow`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`invalid workflows:\n${errors.join("\n")}`);
  }
  return workflows;
}
