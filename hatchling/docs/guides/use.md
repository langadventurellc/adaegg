# Use a hatchling

You read this when you are an agent (or a person) asking a hatchling to change itself, or checking on the work it is doing.

A hatchling changes only through its queue: you describe work, the daemon does it. Run every command below from the repo root with `bin/hatch <command>` (or `npm run hatch -- <command>`). The full command list is in `AGENTS.md`.

## Two ways to ask for change

| Use | When | What happens |
| --- | --- | --- |
| `hatch add "<title>"` (an `item`) | You have a finished spec: you know the files, the behaviour and the tests. | The `implement` workflow (`workflows/implement.yaml`) runs it: branch, implement, checks, review, merge. |
| `hatch add "<title>" --kind request` | You have an idea, or something larger or vaguer than one implementer can do in one go. | The `request` workflow (`workflows/request.yaml`) plans it into a chain of items. The `verify` workflow (`workflows/verify.yaml`) then checks the result. |

Prefer an item when you can write the spec; a request spends an extra planning run and may produce a plan you did not intend. A request is verified at most `maxVerifyRounds` times (default 2, the `enqueue` node's config). A request whose plan has exactly one item gets no verification. See [workflows](../system/workflows.md) for the details.

## Ask in the browser

The browser is another way to ask. Open the URL from `hatch status` (the `ui` line). Anything asked there becomes a `request` that the daemon plans, like `hatch add --kind request`. See [ui](../system/ui.md).

## Write a good item

Nobody can answer questions in the middle of a run: the implementer sees only the title and the contents. An item that leaves a decision open gets a guess. Give the contents these sections:

- **Why**: the problem and who it affects, so the implementer can judge edge cases.
- **What to build**: the files and functions to change, and existing code to copy the pattern from.
- **Tests**: what must be tested and where.
- **Done when**: observable conditions the reviewer can check.
- **Out of scope**: what must not change, so the diff stays small.

Example, fed through `--file` (or the same text on stdin):

```
hatch add "Show the run count in hatch status" --file spec.md
```

```
## Why
`hatch status` shows item counts but not how many runs are active.

## What to build
In `src/cli/main.ts`, add a line `runs  <n> running` to the status output, using the same helpers as the item counts.

## Tests
Extend the status test in `src/cli/main.test.ts` to expect the new line.

## Done when
- `hatch status` prints the extra line.
- `npm run check` passes.

## Out of scope
No change to the database schema.
```

`hatch add` reads the contents from `--file`, else from stdin when it is piped. It prints `queued <id>` with the first 8 characters of the new item's id.

## Chain work

- `--blocked-by <id>` (repeatable): the item waits until every blocker is `done`. Use it when a later item needs an earlier one's code.
- `--parent <id>`: records the item as a child of another (planned items are children of their request).
- `--priority <n>`: an integer, default 0; higher is claimed first, then the oldest.

A blocker that fails or is cancelled does not fail its dependants: they stay `queued` until you `hatch retry` the blocker (see [queue](../system/queue.md)).

## Read status

```
hatch status               # count per status, and whether the daemon is up
hatch list                 # all items; add --status <s> or --json
hatch show <id>            # one item, its blockers, its runs and node runs
hatch runs --limit 5       # newest runs first (default 20)
```

Ids may be a prefix of 4 or more characters.

Statuses:

| Status | Meaning |
| --- | --- |
| `queued` | waiting to be claimed (or waiting for blockers) |
| `in_progress` | claimed; a run is working on it |
| `done` | the run reached `end` (for an item: merged) |
| `failed` | the run failed; `hatch show` has the error |
| `cancelled` | you cancelled it while queued |

Kinds: `item` (built by `implement`), `request` (planned into items), `verify` (checks a request was delivered), and the id of a cron workflow, such as `tidy`, for scheduled items. See [queue](../system/queue.md).

## Cancel and retry

- `hatch cancel <id>` works on `queued` items only. An item already `in_progress` cannot be cancelled.
- `hatch retry <id>` works on `failed` or `cancelled` items only. It queues the item again; a retried item continues in its earlier worktree, so finished work is not lost.

## Transcripts and costs

- The transcript of each agent attempt is `.adaegg/logs/<run8>/<node id>-<attempt>.jsonl`, where `<run8>` is the first 8 characters of the run id (`hatch runs` or `hatch show <id>` shows it). If `ADAEGG_STATE_DIR` is set, look under `$ADAEGG_STATE_DIR/logs/`.
- The cost of each node run is in `hatch show <id>`. Token counts (`inputTokens`, `outputTokens`) appear only in `hatch show <id> --json`, which also includes each run's `state` (review `findings` and `checkOutput`).

## The schedule

The daemon adds a `tidy` item every day at 03:17 local time. It removes the worktrees and branches of merged items and log directories older than `retainLogDays` (default 30). See `workflows/tidy.yaml` and [workflows](../system/workflows.md). If something looks wrong, read [support](support.md).
