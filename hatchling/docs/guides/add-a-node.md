# Add a node type

A node type is one step a workflow can use (see `docs/system/workflows.md`).

## The interface

`src/engine/nodes/types.ts`:

```ts
type NodeType<C> = {
  type: string;                      // the name workflows use
  outcomes: readonly string[];       // every outcome run() may return
  configSchema: z.ZodType<C>;        // validates the node's `config`
  run(ctx: NodeContext<C>): Promise<NodeResult>;
};
```

`ctx` holds `workItem`, `runId`, `nodeId`, `attempt` (which attempt of this node in the run, from 1), `state` (the `RunState`), the validated `config`, `db` (the open `DatabaseSync`; use `inTransaction` from `store.ts` for several writes), `paths` (`root`, `stateDir`), `appConfig`, an abort `signal` and `now()`. `run` returns `{ outcome, problem?, state?, costUsd?, tokens? }`; `state` is a patch merged shallowly into the run state. Nodes talk to each other only through `state`; never import another node.

## Steps

1. Create `src/engine/nodes/<name>.ts` and export `defineNode({ type, outcomes, configSchema, run })`. `defineNode` only widens the config type so the node fits the registry.
2. Register it in `builtinNodeTypes` in `src/engine/nodes/index.ts`. Workflows refer to it by `type`.
3. Declare every outcome in `outcomes`. The loader requires every workflow using the node to have an edge for each one, so declare only outcomes you return.
4. Describe the config with a Zod schema (`z.object({})` if none). The loader validates it at load time, so a bad config never reaches a run.
5. Read the signal in long work and stop when it aborts; throw or return, the runner leaves an aborted run `running`.
6. Add a state field in `RunStateSchema` if the node must pass something on (with a default).

## Idempotency

The runner persists `current_node` before the node runs and resumes a `running` run at that node after a restart, so `run` can be called twice for the same step. Check for existing results before doing work (the `branch` node reuses an existing branch and worktree; `merge` returns `merged` if the branch is already on base). Return `problem` text a human or agent can act on.

## Tests

Follow the existing node tests: `src/engine/nodes/branch.test.ts`, `checks.test.ts`, `merge.test.ts`. They build real repos with `buildTemplateRepo`/`copyRepo` and call `node.run(makeCtx(root, { state }))` from `src/engine/nodes/test-repo.ts`; no network and no `npm`. Test each outcome, the second call, and a bad config. `src/daemon/daemon.e2e.test.ts` shows a fake node used inside a full workflow.
