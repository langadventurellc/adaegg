# hatchling

A hatchling is a small, self-rewriting system: it is changed by describing the change as work items, and agents implement them in this repo. Today it has a SQLite work item queue and the `hatch` CLI. The daemon, workflows and agents that run the queue are not present yet.

## Layout

- `src/engine/`: paths, config, database and queue store.
- `src/cli/`: the `hatch` CLI.
- `src/ui/`: the browser UI (a placeholder for now).
- `bin/hatch`: CLI entry point (`bin/hatch <command>`, or `npm run hatch -- <command>`).
- `docs/system/`: how the system works; start with `queue.md`.
- `adaegg.json`: marks the repo root.
- `.adaegg/`: state (the SQLite database). Git-ignored; never commit it.

## Before you finish

`npm run check` (lint, typecheck, tests, build) must pass.

## The `hatch` CLI

```
hatch add "<title>" [--file <path>] [--blocked-by <id>]... [--parent <id>] [--priority <n>]
hatch list [--status <s>] [--json]
hatch show <id> [--json]
hatch cancel <id>      # queued items only
hatch retry <id>       # failed or cancelled items only
hatch status           # count per status
```

`add` reads the contents from `--file`, else from stdin when it is piped. Ids may be a prefix of at least 4 characters. `hatch add` is how you chain requests: queue follow-up work with `hatch add "title" --blocked-by <id>` and it waits until that item is done.

## Worktrees

Work in a git worktree, never in the main checkout. `findRepoRoot` resolves a linked worktree to the main checkout, and `ADAEGG_STATE_DIR` (absolute path) overrides the state directory, so every worktree reaches the one queue.

## Conventions

- ESM and strict TypeScript. Node runs `.ts` directly: use explicit `.ts` import extensions and erasable syntax only (no `enum`, no code-bearing `namespace`, no parameter properties).
- Write tests with every change.
