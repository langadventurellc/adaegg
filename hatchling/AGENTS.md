# hatchling

A hatchling is a small, self-rewriting system: it is changed by describing the change as work items, and agents implement them in this repo. It has a SQLite work item queue, the `hatch` CLI, and a daemon that claims queued items and runs them through YAML workflows (branch, checks, merge). The shipped `implement` workflow adds Claude agents (through the Agent SDK) that implement and review each item; see `docs/system/agents.md`.

## Layout

- `src/engine/`: paths, config, database, queue store, run store, runner, workflow loader and node types (`nodes/`).
- `src/daemon/`: the daemon (`daemon.ts`) and its entry point (`main.ts`).
- `src/cli/`: the `hatch` CLI.
- `workflows/`: workflow YAML files, loaded at daemon start (`implement.yaml` is the shipped one).
- `prompts/`: the role prompts the agent nodes send (`implement.md`, `review.md`).
- `src/ui/`: the browser UI (a placeholder for now).
- `bin/hatch`: CLI entry point (`bin/hatch <command>`, or `npm run hatch -- <command>`).
- `docs/system/`: how the system works; start with `queue.md` and `workflows.md`; `agents.md` covers the agent nodes. `docs/guides/add-a-node.md` explains how to add a node type.
- `adaegg.json`: marks the repo root.
- `.adaegg/`: state (the SQLite database). Git-ignored; never commit it.

## Before you finish

`npm run check` (lint, typecheck, tests, build) must pass.

## The `hatch` CLI

```
hatch add "<title>" [--file <path>] [--blocked-by <id>]... [--parent <id>] [--priority <n>]
hatch list [--status <s>] [--json]
hatch show <id> [--json]   # also lists the item's runs and node runs
hatch runs [--limit n]     # newest runs first (default 20)
hatch cancel <id>      # queued items only
hatch retry <id>       # failed or cancelled items only
hatch status           # count per status
```

`add` reads the contents from `--file`, else from stdin when it is piped. Ids may be a prefix of at least 4 characters. `hatch add` is how you chain requests: queue follow-up work with `hatch add "title" --blocked-by <id>` and it waits until that item is done.

## The daemon

`npm run daemon` loads `workflows/`, resumes interrupted runs, then claims queued items every 2 seconds (at most `maxConcurrentRuns` at once). An invalid workflow file is printed to stderr and the daemon exits 1. SIGINT/SIGTERM stop it and leave running runs to resume on the next start.

## Changing prompts and workflows

- To change how an agent behaves, edit its prompt in `prompts/` (`implement.md`, `review.md`). The review prompt must keep ending in the verdict JSON `{ "verdict": "approve" | "changes", "findings": [] }`.
- To change the cycle, edit `workflows/implement.yaml`. The loader refuses to start the daemon if an outcome of a node has no edge or a node config is invalid (for example `output: verdict` on an `agent` node; use `review`). It does not detect cycles: keeping every loop bounded by an edge with `max` is a convention, and `src/engine/workflows/implement.test.ts` verifies it for the shipped file. Update the edge table in `docs/system/workflows.md` with it.
- Models are `models.implement` and `models.review` in `adaegg.json`.
- Chaining work is `bin/hatch add "<title>" --blocked-by <id>`: the new item waits until that one is done.

## Git layout

The daemon works in worktrees under `.adaegg/worktrees/<id8>` on branches `hatch/<id8>-<slug>` (`<id8>` is the first 8 characters of the work item id), and merges them into the base branch in the main checkout, which must be clean and on that branch.

## Worktrees

Work in a git worktree, never in the main checkout. `findRepoRoot` resolves a linked worktree to the main checkout, and `ADAEGG_STATE_DIR` (absolute path) overrides the state directory, so every worktree reaches the one queue.

## Conventions

- ESM and strict TypeScript. Node runs `.ts` directly: use explicit `.ts` import extensions and erasable syntax only (no `enum`, no code-bearing `namespace`, no parameter properties).
- Write tests with every change.
