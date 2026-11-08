# Change a hatchling

You read this when you are an agent about to change a hatchling's own code, prompts, workflows or docs, and need to know whether to edit directly or queue the change.

## How a hatchling changes itself

Describe the change as an item (or a request for something large; see [use](use.md)). The daemon branches, implements, runs the checks, reviews and merges it. That path is the safe one: it works in a separate worktree, it checks and reviews the result, and a merge that touches the hatchling's own code gets a restart and a rollback if the new daemon does not come up.

## Edit directly or queue it

Edit directly only for docs-only fixes (files under `docs/`, and `AGENTS.md`), and only in a git worktree, never in the main checkout the daemon merges into. The `merge` node refuses a dirty main checkout, so an edit left there blocks every merge.

Queue an item for anything under `src/`, `workflows/`, `prompts/`, `bin/`, or config (`adaegg.json`, `package.json`). Those files define how the daemon runs; changing them by hand skips the restart and rollback protection, so a mistake could leave a hatchling that cannot start.

## Files that define behaviour

| File | What changing it does |
| --- | --- |
| `prompts/implement.md`, `prompts/review.md` | Changes how the implementer and the reviewer behave. The review prompt must keep ending in the verdict JSON `{ "verdict": "approve" \| "changes", "findings": [] }`. |
| `prompts/plan.md`, `prompts/verify.md` | Changes planning and verification. Both must keep ending in the plan JSON `{ "summary": "...", "items": [{ "key", "title", "contents", "dependsOn" }] }`. |
| `workflows/*.yaml` | Changes the cycle a work item goes through. Keep every loop bounded by an edge with `max`, and update the edge table in [workflows](../system/workflows.md). |
| `adaegg.json` | Configuration: `baseBranch`, `checks`, `setup`, `checksTimeoutMinutes`, `maxConcurrentRuns` and `models.implement` / `models.review`. Models are read once when the daemon starts, so they take effect after a restart. |
| `src/engine/nodes/` | A new node type: follow [add a node](add-a-node.md). |

Rules that tests enforce:

- The `plan` node of `workflows/request.yaml` and the `verify` node of `workflows/verify.yaml` stay read-only: `cwd: root`, no write tools, only read-only `git` and `ls` bash patterns. They share the main checkout with the daemon, and a dirty checkout blocks merges. `src/engine/workflows/request.test.ts` checks it.
- Every loop in `workflows/implement.yaml` goes through an edge with `max`, so a run cannot cycle forever. `src/engine/workflows/implement.test.ts` checks it. The loader does not detect cycles, so keep the convention in every workflow you write.

`maxVerifyRounds` is not an `adaegg.json` key: it is the `enqueue` node's `config` in the workflow YAML (default 2).

A schedule is the workflow's trigger: `trigger: { type: cron, schedule: "..." }`. See [workflows](../system/workflows.md) for the syntax.

## Which merges restart the daemon

A merge that touches `src/`, `workflows/`, `prompts/`, `bin/`, `package.json`, `package-lock.json` or `adaegg.json` makes the daemon exit 75; the supervisor (`hatch start`) restarts it. If the new daemon is not healthy within the probation window, the supervisor rolls back with `git revert` and marks the item `failed`. A docs-only merge restarts nothing. Details: [restart and rollback](../system/restart-and-rollback.md).

## Code, tests and docs change together

Every change updates the code, its tests and the docs that describe it, in the same item. `npm run check` (lint, typecheck, tests, build) must pass before the item is finished; the checks run again before the merge.

## Add a workflow

1. Copy `workflows/tidy.yaml` to `workflows/<name>.yaml`.
2. Set `id` (unique) and `name`. For a queue workflow set `trigger: { type: queue, kind: <kind> }`.
3. Set `start` to a node id, and list the `nodes` (`id`, `type`, optional `config`). The node types are registered in `src/engine/nodes/index.ts`.
4. Add `edges`: one for every outcome of every node, ending at `end` or `fail`. Put `max` on any edge that makes a loop.
5. Describe the workflow and its edge table in [workflows](../system/workflows.md).
6. Run `npm test` and `npm run check`.

## Add a schedule

1. Set `trigger: { type: cron, schedule: "<minute> <hour> <day of month> <month> <day of week>" }` in the workflow file, in machine local time.
2. The workflow `id` becomes the kind of the items it creates. No cron workflow `id` may equal the `kind` of a queue workflow, or it would claim that queue's items.
3. Nothing fires the first time the daemon sees the workflow; it fires from the next slot.

## The safety net

The loader checks every file when the daemon starts (see Load-time checks in [workflows](../system/workflows.md)). An invalid file makes the daemon print the problems and exit 1, so a mistake is caught at start and not midway through a run. Run the loader tests with `npm test` before you finish; they load the shipped workflows.
