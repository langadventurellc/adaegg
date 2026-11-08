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

- `trigger` is `{ type: queue, kind }` or `{ type: cron, schedule }`; any other type is rejected (`supported: 'queue', 'cron'`). Whatever the trigger, the daemon claims with `claimNext(db, workflowKind(workflow))` (`src/engine/workflows/schema.ts`): the queue trigger's `kind`, or the workflow `id` for a cron workflow.
- A node has an `id` (unique in the workflow), a `type` (a registered node type, see `src/engine/nodes/index.ts`) and an optional `config`, validated by that type's Zod schema.
- `to` is a node id or one of the reserved targets `end` (the run succeeded) and `fail` (the run failed).

## The `cron` trigger

```yaml
trigger: { type: cron, schedule: "17 3 * * *" }   # 03:17 every day, machine local time
```

`schedule` has five fields (minute, hour, day of month, month, day of week) with crontab syntax: `*`, numbers, `a-b`, comma lists, `/n` steps after `*` or a range, three-letter month and weekday names, and weekday 0 or 7 for Sunday. When both day fields are restricted a day matches if either does. Macros such as `@daily` are not supported. Times are the machine's local time. The parser is `src/engine/cron.ts`.

At the start of each daemon tick, `fireDueSchedules` (`src/engine/schedule.ts`) handles every cron workflow in one transaction:

- The `schedules` table (`workflow_id`, `last_checked_at`) records when the schedule was last checked. It is in SQLite, not memory, so a restart after a self-change (exit 75) neither fires twice nor loses a slot.
- First sight of a workflow (no row) inserts the current time and fires nothing: installing a hatchling or adding a schedule never fires at once.
- If the next slot after `last_checked_at` is at or before now, `last_checked_at` becomes now and one work item is added, with the workflow's `name` as title and the workflow `id` as kind. A daemon that was down fires one catch-up run, never a backlog.
- If an item of that kind is already `queued` or `in_progress`, no item is added, but `last_checked_at` still advances, so a slow run never piles up copies.

The daemon claims these items through the normal runner, and only the workflow with that id claims them. Nothing fires while a restart is pending or `restart.json` exists.

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
- the trigger type is `queue` or `cron`, and workflow ids are unique;
- a cron `schedule` parses (the error names the bad field) and runs at least once within 5 years (`0 0 31 2 *` never does);
- no cron workflow has an id equal to the `kind` of a queue workflow, because it would claim that queue's items.

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

## The shipped `request` and `verify` workflows

`workflows/request.yaml` (trigger kind `request`, start `plan`) plans a request: the read-only `plan` node (an `agent` with `cwd: root` and `output: plan`, prompt `prompts/plan.md`) reads the main checkout and answers with a plan, then `enqueue` creates the chain of `item`s and, for two or more items, a verification. `workflows/verify.yaml` (trigger kind `verify`, start `verify`) runs the same shape with the `verify` node (prompt `prompts/verify.md`, model `review`): the verifier reads the code on the base branch and its plan holds only the missing work. An empty plan ends the request; otherwise `enqueue` queues the missing items and the next verification. There are at most `maxVerifyRounds` rounds (default 2); after that the verify item fails visibly with the items the verifier wanted. Neither workflow has a loop, so no edge has a `max`.

`request`:

| From | Outcome | To | Bound |
| --- | --- | --- | --- |
| `plan` | `done` | `enqueue` | |
| `plan` | `failed` | `fail` | |
| `plan` | `blocked` | `fail` | |
| `enqueue` | `queued` | `end` | |
| `enqueue` | `failed` | `fail` | |

`verify`:

| From | Outcome | To | Bound |
| --- | --- | --- | --- |
| `verify` | `done` | `enqueue` | |
| `verify` | `failed` | `fail` | |
| `verify` | `blocked` | `fail` | |
| `enqueue` | `queued` | `end` | |
| `enqueue` | `failed` | `fail` | |

The planner and verifier must not write to the main checkout, because the `merge` node refuses a dirty one: they have only `Read`, `Glob`, `Grep` and read-only `git`/`ls` bash patterns, and `src/engine/workflows/request.test.ts` checks it. A failed item leaves the items blocked by it queued; `hatch retry` is the human step.

## The shipped `tidy` workflow

`workflows/tidy.yaml` (trigger `cron`, schedule `17 3 * * *`, so 03:17 local time every day; items have kind `tidy`; start `tidy`) has one node, the `tidy` node with `retainLogDays: 30`. Change the time in that file's `schedule`.

| From | Outcome | To | Bound |
| --- | --- | --- | --- |
| `tidy` | `tidied` | `end` | |
| `tidy` | `failed` | `fail` | |

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

## Housekeeping nodes

- **`tidy`** (`tidied`, `failed`; config `retainLogDays`, a positive integer, default 30): frees the disk the `branch` node leaves behind. It removes:
  - the worktree `<state dir>/worktrees/<id8>` (`git worktree remove --force`, run in the main checkout) and the branch (`git branch -d`, never `-D`) of each work item with status `done`, only when its branch is a `hatch/` branch that is an ancestor of `baseBranch`. A done item whose branch is not merged, or whose HEAD is detached, is left alone and counted as skipped. `git worktree prune` runs afterwards.
  - each directory directly under `<state dir>/logs/` whose modification time is older than `retainLogDays` days and whose name is not the first 8 characters of a `running` run's id. Files such as `daemon.log` are kept.

  It never touches the worktrees or branches of items in any other status (a failed item's worktree is how `branch` continues it on retry), `.adaegg/` state files, the database, or anything outside `worktrees/` and `logs/`. A failing step does not stop the others; the node returns `failed` with every problem joined, otherwise `tidied`. It writes `tidy: removed N worktrees, N branches, N log directories (skipped N)` to stdout. A second run changes nothing.

## Planning nodes

- **`enqueue`** (`queued`, `failed`; config `maxVerifyRounds`, a positive integer, default 2): turns `state.plan` into a chain of work items. The whole node runs in one transaction, so a failure leaves nothing behind. In order:
  1. The root request is the work item itself when its kind is `request`, or its `parent_id` when it is `verify`. Any other kind, or a `verify` item without a parent, returns `failed`.
  2. If some item already has this item as its `source_id`, it returns `queued` and creates nothing: the node was re-run after a crash.
  3. A missing plan returns `failed`. An empty plan on a `request` returns `failed` (`the planner found nothing to build: <summary>`); on a `verify` item it returns `queued` and creates nothing, because the request is satisfied.
  4. The round is the number of `verify` items under the root, plus 1. This is checked before anything is created.
  5. Each plan item becomes an `item` under the root with this item as `source_id`, the same priority, `blockedBy` the items its `dependsOn` keys name, and contents that start with `Part of the request <id8> "<title>".`.
  6. A verification item (kind `verify`, parent the root, blocked by every item just created) is queued when this item is a `request` with at least 2 plan items, or a `verify` item with at least 1. A request with exactly 1 plan item gets none. Its contents hold the request, the numbered plan items and the round.
- **The round limit**: if a verification would be queued and the round exceeds `maxVerifyRounds`, the node returns `failed` naming the limit and the titles the verifier wanted, and creates nothing. A request must not loop between building and verifying forever; a person looks at it with `hatch show` and decides.
- **Why a node and not the planner running `hatch add`**: the chain is created atomically, validated by the plan schema, and is safe to re-run after a crash.
- A failed item leaves the items blocked by it queued, as for any blocker; `hatch retry` is the human step.
