import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../engine/config.ts";
import type { NodeRegistry } from "../engine/nodes/types.ts";
import { createRunner } from "../engine/runner.ts";
import { listRunningRuns } from "../engine/runs.ts";
import { claimNext, failWorkItem, getWorkItem } from "../engine/store.ts";
import type { Workflow } from "../engine/workflows/schema.ts";

export type DaemonDeps = {
  db: DatabaseSync;
  workflows: Workflow[];
  nodeTypes: NodeRegistry;
  appConfig: Config;
  paths: { root: string; stateDir: string };
  tickMs?: number;
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

  function track(promise: Promise<unknown>): void {
    const tracked: Promise<unknown> = promise
      .catch((err) => {
        process.stderr.write(`daemon: run failed unexpectedly: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => {
        inFlight.delete(tracked);
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
      if (controller.signal.aborted) return;
      for (const workflow of workflows) {
        if (workflow.trigger.type !== "queue") continue;
        while (inFlight.size < appConfig.maxConcurrentRuns && !controller.signal.aborted) {
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
