import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import type { NodeRegistry, NodeResult } from "./nodes/types.ts";
import { RunStateSchema } from "./nodes/types.ts";
import { createRun, getRun, type Run } from "./runs.ts";
import { failWorkItem, finishWorkItem, getWorkItem, inTransaction, type WorkItem } from "./store.ts";
import type { Workflow } from "./workflows/schema.ts";

export type RunnerDeps = {
  db: DatabaseSync;
  workflows: Workflow[];
  nodeTypes: NodeRegistry;
  appConfig: Config;
  paths: { root: string; stateDir: string };
  now?: () => Date;
};

export type Runner = {
  startRun(item: WorkItem, workflow: Workflow, signal: AbortSignal): Promise<Run>;
  resumeRun(runId: string, signal: AbortSignal): Promise<Run>;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createRunner(deps: RunnerDeps): Runner {
  const { db, workflows, nodeTypes, appConfig, paths } = deps;
  const now = deps.now ?? (() => new Date());

  // Marks the run and its work item failed in one transaction.
  function failRun(run: Run, error: string): Run {
    inTransaction(db, () => {
      db.prepare("UPDATE runs SET status = 'failed', current_node = NULL, error = ?, finished_at = ? WHERE id = ?").run(
        error,
        now().toISOString(),
        run.id,
      );
      failWorkItem(db, run.workItemId, error);
    });
    return getRun(db, run.id);
  }

  async function loop(runId: string, signal: AbortSignal): Promise<Run> {
    for (;;) {
      const run = getRun(db, runId);
      if (run.status !== "running" || signal.aborted) return run;

      const workflow = workflows.find((w) => w.id === run.workflowId);
      if (!workflow) return failRun(run, `unknown workflow ${run.workflowId}`);
      const nodeId = run.currentNode;
      const node = workflow.nodes.find((n) => n.id === nodeId);
      if (nodeId === null || !node) return failRun(run, `unknown node ${nodeId ?? "(none)"} in ${workflow.id}`);
      const nodeType = nodeTypes[node.type];
      if (!nodeType) return failRun(run, `unknown node type ${node.type} for node ${node.id}`);
      const parsedConfig = nodeType.configSchema.safeParse(node.config);
      if (!parsedConfig.success) {
        return failRun(
          run,
          `invalid config for node ${node.id}: ${parsedConfig.error.issues[0]?.message ?? "invalid"}`,
        );
      }

      // Persist before running so a crash re-runs this node.
      db.prepare("UPDATE runs SET current_node = ? WHERE id = ?").run(nodeId, run.id);

      const priorRuns = db
        .prepare("SELECT count(*) AS n FROM node_runs WHERE run_id = ? AND node_id = ?")
        .get(run.id, nodeId) as { n: number };
      const attempt = priorRuns.n + 1;
      const startedAt = now().toISOString();

      let result: NodeResult;
      try {
        result = await nodeType.run({
          workItem: getWorkItem(db, run.workItemId),
          state: run.state,
          config: parsedConfig.data,
          paths,
          appConfig,
          signal,
          now,
        });
      } catch (err) {
        // An abort is a shutdown, not a failure: leave the run for the next start.
        if (signal.aborted) return getRun(db, run.id);
        const message = errorMessage(err);
        db.prepare(
          "INSERT INTO node_runs (run_id, node_id, attempt, outcome, problem, started_at, finished_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        ).run(run.id, nodeId, attempt, message, startedAt, now().toISOString());
        return failRun(run, message);
      }
      if (signal.aborted) return getRun(db, run.id);

      const finished = applyResult(run, workflow, nodeId, attempt, startedAt, result);
      if (finished) return finished;
    }
  }

  // Records the node run and moves the run along its edge. Returns the run when it ended.
  function applyResult(
    run: Run,
    workflow: Workflow,
    nodeId: string,
    attempt: number,
    startedAt: string,
    result: NodeResult,
  ): Run | null {
    const edge = workflow.edges.find((e) => e.from === nodeId && e.on === result.outcome);
    const key = `${nodeId}:${result.outcome}`;
    const count = (run.state.edgeCounts[key] ?? 0) + 1;
    let error: string | null = null;
    if (!edge) {
      error = `node ${nodeId} returned outcome ${result.outcome} with no edge in ${workflow.id}`;
    } else if (edge.max !== undefined && count > edge.max) {
      error = `loop ${key} exceeded its limit of ${edge.max}`;
    }

    const ended = inTransaction(db, (): boolean => {
      const finishedAt = now().toISOString();
      db.prepare(
        `INSERT INTO node_runs (run_id, node_id, attempt, outcome, problem, cost_usd, input_tokens, output_tokens, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        nodeId,
        attempt,
        result.outcome,
        result.problem ?? null,
        result.costUsd ?? null,
        result.tokens?.input ?? null,
        result.tokens?.output ?? null,
        startedAt,
        finishedAt,
      );
      if (error !== null || !edge) {
        db.prepare(
          "UPDATE runs SET status = 'failed', current_node = NULL, error = ?, finished_at = ? WHERE id = ?",
        ).run(error, finishedAt, run.id);
        failWorkItem(db, run.workItemId, error ?? "run failed");
        return true;
      }
      const state = RunStateSchema.parse({
        ...run.state,
        ...result.state,
        edgeCounts: { ...run.state.edgeCounts, ...result.state?.edgeCounts, [key]: count },
      });
      const stateJson = JSON.stringify(state);
      if (edge.to === "end") {
        db.prepare(
          "UPDATE runs SET status = 'succeeded', current_node = NULL, state = ?, finished_at = ? WHERE id = ?",
        ).run(stateJson, finishedAt, run.id);
        finishWorkItem(db, run.workItemId);
        return true;
      }
      if (edge.to === "fail") {
        const message = result.problem ?? `run failed at node ${nodeId}`;
        db.prepare(
          "UPDATE runs SET status = 'failed', current_node = NULL, state = ?, error = ?, finished_at = ? WHERE id = ?",
        ).run(stateJson, message, finishedAt, run.id);
        failWorkItem(db, run.workItemId, message);
        return true;
      }
      db.prepare("UPDATE runs SET current_node = ?, state = ? WHERE id = ?").run(edge.to, stateJson, run.id);
      return false;
    });
    return ended ? getRun(db, run.id) : null;
  }

  return {
    async startRun(item, workflow, signal) {
      const run = createRun(db, item, workflow);
      return loop(run.id, signal);
    },
    async resumeRun(runId, signal) {
      return loop(runId, signal);
    },
  };
}
