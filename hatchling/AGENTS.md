# hatchling

A hatchling is a small, self-rewriting system: it is changed by describing the change as work items, and agents implement them in this repo. It has a SQLite work item queue, the `hatch` CLI, and a daemon that claims queued items and runs them through YAML workflows (branch, checks, merge). The shipped `implement` workflow adds Claude agents (through the Agent SDK) that implement and review each item.

## Layout

- `src/engine/`: paths, config, database, queue store, run store, runner, workflow loader and node types (`nodes/`).
- `src/daemon/`: the daemon (`daemon.ts`) and its entry point (`main.ts`).
- `src/supervisor/`: the supervisor behind `hatch start`.
- `src/cli/`: the `hatch` CLI.
- `workflows/`: workflow YAML files, loaded at daemon start.
- `prompts/`: the role prompts the agent nodes send.
- `src/server/`: the local UI server: guard, API, queue summary and Vite middleware.
- `src/ui/`: the browser UI (onboarding and Ask screens, plain TypeScript), served by `src/server/`.
- `src/names/`: the names list, the suggestion picker and name validation for onboarding.
- `bin/hatch`: CLI entry point (`bin/hatch <command>`, or `npm run hatch -- <command>`).
- `README.md`: for people using this repo.
- `docs/`: guides and system docs (see Docs below).
- `adaegg.json`: marks the repo root.
- `.adaegg/`: state (the SQLite database). Git-ignored; never commit it.

## Before you finish

`npm run check` (lint, typecheck, tests, build) must pass.

## The `hatch` CLI

```
hatch add "<title>" [--file <path>] [--kind item|request] [--blocked-by <id>]... [--parent <id>] [--priority <n>]
hatch list [--status <s>] [--json]
hatch show <id> [--json]   # also lists the item's runs and node runs
hatch runs [--limit n]     # newest runs first (default 20)
hatch cancel <id>      # queued items only
hatch retry <id>       # failed or cancelled items only
hatch status           # count per status, then `supervisor  up (pid n)` when a supervisor is running, `daemon  up (pid n)` or `daemon  down`, then `ui  <url>` when the UI is up
hatch start            # run the daemon under the supervisor (also `npm start`)
hatch stop             # stop the supervisor and its daemon (waits until both have exited); never reverts a merge
```

`add` reads the contents from `--file`, else from stdin when it is piped. Ids may be a prefix of at least 4 characters. `hatch add` is how you chain requests: queue follow-up work with `hatch add "title" --blocked-by <id>` and it waits until that item is done. An `item` (the default) is a ready-made spec that is implemented as written. A `request` is a larger or vaguer ask that the daemon plans into a chain of items (and a verification) before anything is built.

## Docs

| Doc | Read it when |
| --- | --- |
| [use](docs/guides/use.md) | you are asking the hatchling for work or checking its status |
| [support](docs/guides/support.md) | something is failing, stuck or won't start |
| [change](docs/guides/change.md) | you are changing prompts, workflows, config or code |
| [add a node](docs/guides/add-a-node.md) | you are adding a workflow node type |
| [queue](docs/system/queue.md) | you need the work item fields, statuses or claiming rules |
| [workflows](docs/system/workflows.md) | you need the workflow YAML, edges, runs or shipped workflows |
| [agents](docs/system/agents.md) | you are touching the agent nodes, prompts or transcripts |
| [names](docs/system/names.md) | you are changing the onboarding names list, the suggestion picker or name validation |
| [ui](docs/system/ui.md) | you are touching the UI server, its API or its guard |
| [restart and rollback](docs/system/restart-and-rollback.md) | you are touching the supervisor or a self-change merge |

Update the docs this file names whenever you change what they describe.

## The daemon

`hatch start` runs the daemon under a supervisor that restarts it after a merge that changed the hatchling's own code and reverts that merge if the new daemon is unhealthy. `npm run daemon` is the daemon alone and does not restart. The daemon loads `workflows/`, resumes interrupted runs, then claims queued items every 2 seconds. An invalid workflow file is printed to stderr and the daemon exits 1. The daemon also serves the UI on 127.0.0.1 (see [ui](docs/system/ui.md)).

## Git layout

The daemon works in worktrees under `.adaegg/worktrees/<id8>` on branches `hatch/<id8>-<slug>` (`<id8>` is the first 8 characters of the work item id), and merges them into the base branch in the main checkout, which must be clean and on that branch.

## Worktrees

Work in a git worktree, never in the main checkout. `findRepoRoot` resolves a linked worktree to the main checkout, and `ADAEGG_STATE_DIR` (absolute path) overrides the state directory, so every worktree reaches the one queue.

## Conventions

- ESM and strict TypeScript. Node runs `.ts` directly: use explicit `.ts` import extensions and erasable syntax only (no `enum`, no code-bearing `namespace`, no parameter properties).
- Write tests with every change.
- Support steps are in `docs/guides/support.md`; how to change prompts and workflows is in `docs/guides/change.md`.
