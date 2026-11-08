# Workflows and runs

A workflow is a graph of nodes, written as YAML in `workflows/*.yaml` so a hatchling can rewrite it. The daemon (`src/daemon/`) claims queued work items and the runner (`src/engine/runner.ts`) walks the graph for each one, recording a run.

## YAML shape

```yaml
id: example
name: Example
trigger: { type: queue, kind: item }   # claims queued work items of this kind
start: branch
nodes:
  - { id: branch, type: branch }
  - { id: checks, type: checks }
edges:
  - { from: branch, on: ok, to: checks }
  - { from: branch, on: fail, to: fail }
  - { from: checks, on: passed, to: end }
  - { from: checks, on: failed, to: branch, max: 2 }   # max bounds how often this edge may be taken in one run
```

- `trigger.type` must be `queue`; `kind` is passed to `claimNext`.
- A node has an `id` (unique in the workflow), a `type` (a registered node type, see `src/engine/nodes/index.ts`) and an optional `config`, validated by that type's Zod schema.
- `to` is a node id or one of the reserved targets `end` (the run succeeded) and `fail` (the run failed).

## Outcomes and edges

A node returns one `outcome` from the list its type declares. The edge with the matching `(from, on)` says where to go next. `max` bounds how often that edge may be taken in one run; taking it once more fails the run with `loop <from>:<on> exceeded its limit of <max>`. Counts live in `state.edgeCounts` under the key `from:on`.

Going to `end` marks the run `succeeded` and the work item `done`. Going to `fail` marks both `failed`; the error is the last node's `problem`. A node that throws fails the run with the error message; the daemon never crashes because of a node.

## Load-time checks

`loadWorkflows(dir, nodeTypes)` validates every file and throws one error naming each file and every problem. It checks that:

- node ids are unique, `start` exists, and every edge's `from` exists and `to` is a node or `end`/`fail`;
- no two edges share `(from, on)`;
- every `on` is an outcome the node's type declares;
- every outcome a node type declares has an edge from that node;
- each node's `config` passes its type's schema;
- the trigger type is `queue`, and workflow ids are unique.

These checks exist because a workflow is rewritten by the system itself. A mistake must fail when the daemon starts (it prints the problems to stderr and exits 1), not midway through a run on a real work item. In particular, requiring an edge for every declared outcome means a rewrite cannot leave an outcome unhandled.

## Runs and `RunState`

Each claimed item gets a `runs` row (`status` `running`, `succeeded` or `failed`, `current_node`, `state` JSON, `error`) and each execution of a node a `node_runs` row (node, attempt, outcome, problem, cost, tokens). `hatch show <id>` and `hatch runs` read them. The run row is created only after the claim succeeds, so a tick with nothing to claim writes nothing.

Nodes talk only through `RunState` (`src/engine/nodes/types.ts`), validated by Zod, and their own config; no node imports another. A node returns a patch that is merged shallowly into the state.

| Field | Meaning |
| --- | --- |
| `base` | the base branch the work branched from |
| `branch` | the item's branch |
| `worktree` | path of the item's worktree |
| `edgeCounts` | times each edge was taken, keyed `from:on` |
| `checkOutput` | tail of the failing checks output (cleared on pass) |
| `checkedCommit` | the branch tip the last passing checks ran on (null after a failure) |
| `findings` | review findings, one string each |
| `conflictFiles` | files that conflicted when merging base |
| `mergeCommit` | the merge commit on base |
| `changedPaths` | files the merge changed; drives restarts (see the `merge` node below) |
| `problem` | the latest problem |
| `plan` | the planner's validated plan; null until a plan node sets it |

## The shipped `implement` workflow

`workflows/implement.yaml` (trigger `queue`, kind `item`, start `branch`) is the basic implement cycle: branch, an `agent` node that implements, checks, a `review` node, then merge. Its prompts are `prompts/implement.md` and `prompts/review.md`; see `agents.md` for the agent nodes.

| From | Outcome | To | Bound |
| --- | --- | --- | --- |
| `branch` | `ok` | `implement` | |
| `branch` | `fail` | `fail` | |
| `implement` | `done` | `checks` | |
| `implement` | `failed` | `fail` | |
| `implement` | `blocked` | `fail` | |
| `checks` | `passed` | `review` | |
| `checks` | `failed` | `implement` | `max: 2` |
| `review` | `approve` | `merge` | |
| `review` | `changes` | `implement` | `max: 2` |
| `review` | `failed` | `fail` | |
| `review` | `blocked` | `fail` | |
| `merge` | `merged` | `end` | |
| `merge` | `moved` | `checks` | `max: 2` |
| `merge` | `conflict` | `implement` | `max: 2` |
| `merge` | `blocked` | `fail` | |

Every loop goes through an edge with a `max`, so a run cannot cycle forever; the third time checks fail the run fails with `loop checks:failed exceeded its limit of 2`. When `implement` runs again it is shown what sent it back (`checkOutput`, `findings` or `conflictFiles`). `implement` has `commit: true`, so its work is committed and an empty branch fails. `blocked` from an agent (not signed in) fails the run; fix the cause and `hatch retry` the item.

## Idempotent resume

The runner writes `current_node` before the node runs. If the process stops (a crash, or SIGINT/SIGTERM, which abort the signal the nodes get), the run stays `running` and the next daemon start resumes it at `current_node`, so that node runs again. Every node must therefore be safe to run twice. A node whose work was cut short by an abort leaves no `node_runs` row.

## Git nodes

- **`branch`** (`ok`, `fail`): the branch is `hatch/<id8>-<slug of title>` and the worktree `<state dir>/worktrees/<id8>` (`.adaegg/worktrees/<id8>`). If the worktree exists it is reused; if only the branch exists, the worktree is added on it; otherwise both are created from `baseBranch`. That is how a retried item continues earlier work. It records the commit the branch started from in git config (`branch.<name>.hatchStart`), which the merge node uses to tell a branch with work from one without. It then runs `setup` in the worktree (an empty string skips it) asynchronously, so a shutdown aborts it; a failing setup gives `fail` with the output tail as the problem.
- **`checks`** (`passed`, `failed`): runs the `checks` command through a shell in the worktree with `CI=1` and the `checksTimeoutMinutes` timeout. It keeps the last 200 lines (at most 20KB) in `state.checkOutput` and clears it on pass. On pass it records the worktree's HEAD in `state.checkedCommit`.
- **`agent`** and **`review`** run Claude; see `docs/system/agents.md`. The models they use are the `models.implement` and `models.review` aliases in `adaegg.json` (both default to `sonnet`).
- **`merge`** (`merged`, `moved`, `conflict`, `blocked`):
  - If the branch is an ancestor of base and has commits of its own (its tip is not the `hatchStart` commit), it returns `merged`, however it got there (merge commit, fast-forward, or through another merged branch). `mergeCommit` is the first commit on base's first-parent history that contains the branch and `changedPaths` is recovered from git, so a re-run after a crash gives the same result.
  - If the main checkout isn't on `baseBranch` or has uncommitted changes (`.adaegg/` ignored), it returns `blocked` with what to clean up. The merge runs in the main checkout, so it must be clean: the merge would otherwise mix the item's work with someone's unfinished edits or fail midway.
  - If base has commits the branch lacks, it merges base into the branch in the worktree first. On conflict it aborts the merge, puts the files in `state.conflictFiles` and returns `conflict`. On a clean merge it returns `moved`, so the workflow re-runs the checks. Base is brought in first so the checks run on exactly what will land on base, and conflicts are resolved in the worktree, never in the main checkout. Before merging base in, the node writes `branch.<name>.hatchMovedFrom` (the old tip). If a crash lost the `moved` outcome, the next run sees a tip that differs from it and, unless `state.checkedCommit` is that tip, returns `moved` again, so the combined commit is always checked before it lands.
  - Otherwise it runs `git merge --no-ff -m "hatch: <title> (<id8>)" <branch>` in the main checkout. A failure aborts the merge and returns `blocked`. On success it sets `mergeCommit` and `changedPaths` and returns `merged`.
  - `changedPaths` drives restarts: when a run succeeds and its merge touched `src/`, `workflows/`, `prompts/`, `bin/`, `package.json`, `package-lock.json` or `adaegg.json`, the daemon writes `<state>/restart.json`, stops claiming, waits for other runs and exits 75. See `restart-and-rollback.md`.
