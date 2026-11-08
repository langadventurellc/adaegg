import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../engine/config.ts";
import {
  type RestartRequest,
  readRestartRequest,
  restartPath,
  touchesRestartPaths,
  writeRestartRequest,
} from "../engine/lifecycle.ts";
import { git, isAncestor } from "../engine/nodes/git.ts";
import type { NodeRegistry } from "../engine/nodes/types.ts";
import { createRunner } from "../engine/runner.ts";
import { listRunningRuns, type Run } from "../engine/runs.ts";
import { claimNext, failWorkItem, getWorkItem } from "../engine/store.ts";
import type { Workflow } from "../engine/workflows/schema.ts";

export type DaemonDeps = {
  db: DatabaseSync;
  workflows: Workflow[];
  nodeTypes: NodeRegistry;
  appConfig: Config;
  paths: { root: string; stateDir: string };
  tickMs?: number;
  // Called once, with no run in flight, after a merge changed the daemon's own code.
  onRestart?: (request: RestartRequest) => void;
};

export type Daemon = {
  start(): Promise<void>;
  tick(): Promise<void>;
  stop(): Promise<void>;
};

export function createDaemon(deps: DaemonDeps): Daemon {
  const { db, workflows, appConfig } = deps;
  const tickMs = deps.tickMs ?? 2000;
  const runner = createRunner({ db, workflows, nodeTypes: deps.nodeTypes, appConfig, paths: deps.paths });
  const controller = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  let restartPending: RestartRequest | null = null;
  let restartCalled = false;

  // After a run whose merge changed the daemon's own code: record the request and stop claiming.
  function requestRestartIfNeeded(run: Run): void {
    const { mergeCommit, changedPaths } = run.state;
    if (run.status !== "succeeded" || !mergeCommit || !touchesRestartPaths(changedPaths)) return;
    try {
      const root = deps.paths.root;
      // A request already pending (here, or left by a run resumed while the supervisor still has the previous merge on
      // probation) keeps covering its merges: the new one is added, never written over it.
      const existing = restartPending ?? readRestartRequest(deps.paths.stateDir);
      let request: RestartRequest;
      if (existing) {
        const newer = isAncestor(root, existing.mergeCommit, mergeCommit);
        const [latest, other] = newer
          ? [{ mergeCommit, workItemId: run.workItemId }, existing]
          : [existing, { mergeCommit, workItemId: run.workItemId }];
        request = {
          mergeCommit: latest.mergeCommit,
          workItemId: latest.workItemId,
          preMergeHead: existing.preMergeHead,
          requestedAt: new Date().toISOString(),
          earlier: [
            ...(existing.earlier ?? []),
            { mergeCommit: other.mergeCommit, workItemId: other.workItemId },
          ].filter((m) => m.mergeCommit !== latest.mergeCommit),
        };
      } else {
        request = {
          mergeCommit,
          workItemId: run.workItemId,
          preMergeHead: git(root, "rev-parse", `${mergeCommit}^1`),
          requestedAt: new Date().toISOString(),
        };
      }
      writeRestartRequest(deps.paths.stateDir, request);
      restartPending = request;
    } catch (err) {
      process.stderr.write(`daemon: cannot request a restart: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  function track(promise: Promise<Run>): void {
    const tracked: Promise<unknown> = promise
      .then(requestRestartIfNeeded)
      .catch((err) => {
        process.stderr.write(`daemon: run failed unexpectedly: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => {
        inFlight.delete(tracked);
        if (restartPending && inFlight.size === 0 && !restartCalled) {
          restartCalled = true;
          deps.onRestart?.(restartPending);
        }
      });
    inFlight.add(tracked);
  }

  return {
    async start() {
      for (const run of listRunningRuns(db)) track(runner.resumeRun(run.id, controller.signal));
      timer = setInterval(() => {
        void this.tick();
      }, tickMs);
    },

    async tick() {
      // While restart.json exists the supervisor is still judging a self-change (this daemon is on probation), so
      // claim nothing: a second self-change now would race the supervisor's verdict on the first.
      const blocked = () => restartPending !== null || existsSync(restartPath(deps.paths.stateDir));
      if (controller.signal.aborted || blocked()) return;
      for (const workflow of workflows) {
        if (workflow.trigger.type !== "queue") continue;
        while (inFlight.size < appConfig.maxConcurrentRuns && !controller.signal.aborted && !blocked()) {
          let item: ReturnType<typeof claimNext>;
          try {
            item = claimNext(db, workflow.trigger.kind);
          } catch (err) {
            process.stderr.write(`daemon: claim failed: ${err instanceof Error ? err.message : String(err)}\n`);
            return;
          }
          if (!item) break;
          const claimed = item;
          track(
            runner.startRun(claimed, workflow, controller.signal).catch((err) => {
              // The runner records node errors itself; this is a failure around it. Don't leave the item claimed.
              const message = err instanceof Error ? err.message : String(err);
              if (getWorkItem(db, claimed.id).status === "in_progress") failWorkItem(db, claimed.id, message);
              throw err;
            }),
          );
        }
      }
    },

    async stop() {
      controller.abort();
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.allSettled([...inFlight]);
    },
  };
}
