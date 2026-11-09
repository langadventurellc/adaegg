# Work item queue

The queue lives in SQLite (`src/engine/db.ts`, `src/engine/store.ts`). The `hatch` CLI reads and writes it; the daemon claims from it and the runner records runs (see `workflows.md`).

## Work item

| Field | Meaning |
| --- | --- |
| `id` | UUID from `crypto.randomUUID()` |
| `title` | short summary |
| `contents` | the request body (may be empty) |
| `kind` | defaults to `item`; `claimNext` claims by kind |
| `status` | see below |
| `priority` | integer, default 0; higher is claimed first |
| `parent_id` | optional parent item |
| `source_id` | the item that created this one; used by `enqueue` to find its own earlier items |
| `error` | failure message, set by `failWorkItem`, cleared by retry |
| `created_at`, `updated_at`, `finished_at` | ISO timestamps; `finished_at` is set on done, failed and cancelled |

Blockers are rows in `work_item_blocks(item_id, blocked_by_id)`.

## Kinds

- `item`: built by the `implement` workflow.
- `request`: planned into a chain of `item`s.
- `verify`: checks that a request was delivered.

- A cron workflow's id: scheduled items. `fireDueSchedules` adds one, titled with the workflow's `name`, when its schedule is due and none of that kind is `queued` or `in_progress` (see the `cron` trigger in `workflows.md`).

Items are created by the `hatch add` CLI, by the `enqueue` node (planned items), by cron schedules, and by the UI API: `POST /api/ask` adds a `request` (see [ui](ui.md)).

The `parent_id` of planned items and of their verification is the root request.

## Statuses and transitions

`queued`, `in_progress`, `done`, `failed`, `cancelled`.

- `queued` → `in_progress` (claim) or `cancelled` (cancel).
- `in_progress` → `done` (finish) or `failed` (fail). The daemon claims an item (`in_progress`) and starts a run for it; the runner finishes or fails the item when the run reaches `end` or `fail`. A run interrupted by a shutdown leaves the item `in_progress` and is resumed on the next start.
- `failed` or `cancelled` → `queued` (retry).

Any other transition throws.

## Blocking

An item is claimable only when all its blockers are `done`. A blocker that is `failed` or `cancelled` does not release or fail its dependants: they stay `queued` and are shown as blocked by that item. Retrying the blocker lets them proceed. `addWorkItem` rejects a blocker that does not exist and a self-block.

## Claiming

`claimNext(db, kind)` runs in one transaction (`BEGIN IMMEDIATE`). It picks the queued item of that kind, with all blockers done, with the highest priority and then the oldest `created_at`, and sets it `in_progress`. When nothing is claimable it returns null and writes nothing (no `updated_at` changes). Two claims never return the same item. The daemon creates the item's `runs` row only after a claim succeeds, so an empty claim writes nothing at all.

## Ids

Commands accept a full id or a prefix of at least 4 characters. A shorter, unknown or ambiguous prefix is an error that says which.

## State directory

The database is `<root>/.adaegg/hatch.db`. `ADAEGG_STATE_DIR` (absolute path) replaces `<root>/.adaegg`. `<root>` comes from `findRepoRoot`: the directory with `adaegg.json`, resolved to the main checkout when run in a linked git worktree.

## Why

- **WAL and busy timeout (5000 ms):** the CLI and the daemon share one file, so readers must not block the writer and a briefly locked database must be waited on, not fail.
- **`ADAEGG_STATE_DIR` and worktree resolution:** agents run in git worktrees but must reach the one queue.
- **`node:sqlite`:** it needs no native build on the user's machine (unlike `better-sqlite3`). It has no transaction helper, so transactions use `BEGIN`/`COMMIT` through `exec`.
