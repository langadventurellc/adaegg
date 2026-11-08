import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type RunState, RunStateSchema } from "./nodes/types.ts";
import type { WorkItem } from "./store.ts";
import type { Workflow } from "./workflows/schema.ts";

export type RunStatus = "running" | "succeeded" | "failed";

export type Run = {
  id: string;
  workItemId: string;
  workflowId: string;
  status: RunStatus;
  currentNode: string | null;
  state: RunState;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type NodeRun = {
  id: number;
  runId: string;
  nodeId: string;
  attempt: number;
  outcome: string | null;
  problem: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: string;
  finishedAt: string | null;
};

type Row = Record<string, unknown>;

export function toRun(row: Row): Run {
  return {
    id: row.id as string,
    workItemId: row.work_item_id as string,
    workflowId: row.workflow_id as string,
    status: row.status as RunStatus,
    currentNode: (row.current_node as string | null) ?? null,
    state: RunStateSchema.parse(JSON.parse(row.state as string)),
    error: (row.error as string | null) ?? null,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

function toNodeRun(row: Row): NodeRun {
  return {
    id: row.id as number,
    runId: row.run_id as string,
    nodeId: row.node_id as string,
    attempt: row.attempt as number,
    outcome: (row.outcome as string | null) ?? null,
    problem: (row.problem as string | null) ?? null,
    costUsd: (row.cost_usd as number | null) ?? null,
    inputTokens: (row.input_tokens as number | null) ?? null,
    outputTokens: (row.output_tokens as number | null) ?? null,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

export function createRun(db: DatabaseSync, item: WorkItem, workflow: Workflow): Run {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO runs (id, work_item_id, workflow_id, status, current_node, state, started_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?)`,
  ).run(id, item.id, workflow.id, workflow.start, JSON.stringify(RunStateSchema.parse({})), new Date().toISOString());
  return getRun(db, id);
}

export function getRun(db: DatabaseSync, id: string): Run {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
  if (!row) throw new Error(`no run matches ${id}`);
  return toRun(row);
}

export function listRunningRuns(db: DatabaseSync): Run[] {
  return db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at, rowid").all().map(toRun);
}

export function listRuns(db: DatabaseSync, opts: { limit?: number } = {}): Run[] {
  const limit = opts.limit ?? 20;
  return db.prepare("SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?").all(limit).map(toRun);
}

export function listRunsForItem(db: DatabaseSync, itemId: string): Run[] {
  return db.prepare("SELECT * FROM runs WHERE work_item_id = ? ORDER BY started_at, rowid").all(itemId).map(toRun);
}

export function listNodeRuns(db: DatabaseSync, runId: string): NodeRun[] {
  return db.prepare("SELECT * FROM node_runs WHERE run_id = ? ORDER BY id").all(runId).map(toNodeRun);
}
