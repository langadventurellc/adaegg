# Work item queue

The queue lives in SQLite (`src/engine/db.ts`, `src/engine/store.ts`). The `hatch` CLI reads and writes it today; a daemon will claim from it later.

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
| `error` | failure message, set by `failWorkItem`, cleared by retry |
| `created_at`, `updated_at`, `finished_at` | ISO timestamps; `finished_at` is set on done, failed and cancelled |

Blockers are rows in `work_item_blocks(item_id, blocked_by_id)`.

## Statuses and transitions

`queued`, `in_progress`, `done`, `failed`, `cancelled`.

- `queued` → `in_progress` (claim) or `cancelled` (cancel).
- `in_progress` → `done` (finish) or `failed` (fail).
- `failed` or `cancelled` → `queued` (retry).

Any other transition throws.

## Blocking

An item is claimable only when all its blockers are `done`. A blocker that is `failed` or `cancelled` does not release or fail its dependants: they stay `queued` and are shown as blocked by that item. Retrying the blocker lets them proceed. `addWorkItem` rejects a blocker that does not exist and a self-block.

## Claiming

`claimNext(db, kind)` runs in one transaction (`BEGIN IMMEDIATE`). It picks the queued item of that kind, with all blockers done, with the highest priority and then the oldest `created_at`, and sets it `in_progress`. When nothing is claimable it returns null and writes nothing (no `updated_at` changes). Two claims never return the same item.

## Ids

Commands accept a full id or a prefix of at least 4 characters. A shorter, unknown or ambiguous prefix is an error that says which.

## State directory

The database is `<root>/.adaegg/hatch.db`. `ADAEGG_STATE_DIR` (absolute path) replaces `<root>/.adaegg`. `<root>` comes from `findRepoRoot`: the directory with `adaegg.json`, resolved to the main checkout when run in a linked git worktree.

## Why

- **WAL and busy timeout (5000 ms):** the CLI and the daemon share one file, so readers must not block the writer and a briefly locked database must be waited on, not fail.
- **`ADAEGG_STATE_DIR` and worktree resolution:** agents run in git worktrees but must reach the one queue.
- **`node:sqlite`:** it needs no native build on the user's machine (unlike `better-sqlite3`). It has no transaction helper, so transactions use `BEGIN`/`COMMIT` through `exec`.
