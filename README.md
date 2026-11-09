# Ada Egg

Ada Egg gives people a tool for growing their own software. Each install hatches a *hatchling*: a small self-rewriting system that starts blank and, when you ask, rewrites itself into software for you and nobody else. You describe what you want in plain language; agents change the hatchling's own repository to provide it. Ada Egg is built on the foundations of Ada, an engine that builds software the same way, much simplified.

Repository: https://github.com/langadventurellc/adaegg

## Status

Early: version 0.1.0. Tested on Linux. macOS should work. Windows is untested.

## What you need

- Node 24 or newer
- git
- A Claude login (what the `claude` command creates) or `ANTHROPIC_API_KEY`
- pnpm, only if you install from a clone (see below)

Nothing else: no Postgres, Docker, Kubernetes or mise. A hatchling itself needs only npm, and its queue is the built-in `node:sqlite`. pnpm is used only to build the installer from a clone.

## Quick start

### Install from a clone

This works today.

```
git clone https://github.com/langadventurellc/adaegg
cd adaegg
pnpm install
pnpm build
node bin/adaegg.mjs init ../my-hatchling
cd ../my-hatchling
npm start
```

This route needs pnpm, which comes from `mise.toml` (if you use mise) or from Corepack (`corepack enable`). Run `pnpm build` before `node bin/adaegg.mjs`, because that script runs the compiled installer.

### With npx, once the package is published

`adaegg` is not on npm yet, so this does not work until it is published.

```
npx adaegg init my-hatchling
cd my-hatchling
npm start
```

Then open the line printed as `hatchling UI: <url>`. The UI is on 127.0.0.1, port 4747 or a free port if that one is taken. Onboarding asks you to name your hatchling. It suggests a name, never "Ada", and you may type anything. After that the screen is `Ask <name>` with some suggested starter requests. Pick one or write your own.

`adaegg init [<dir>] [--skip-check]` creates your own repository (the folder defaults to `hatchling`). From a clone you run it as `node bin/adaegg.mjs init`; once published, as `npx adaegg init`. It:

- copies the hatchling template into the folder;
- runs `git init` on branch `main`;
- sets a local git identity only when you have none;
- turns commit and tag signing off in that repo, because agents cannot answer a passphrase prompt;
- runs `npm install`;
- makes the first commit;
- runs the hatchling's own `npm run check` (`--skip-check` skips this).

The repository is local only. Nothing is pushed anywhere. You may add your own remote later.

## How a request becomes software

Everything you ask becomes a *request*. A planner agent splits it into a chain of items, and each item goes through the `implement` workflow. A verification then checks the result.

- request: what you typed in the UI
  - plan: a planner agent splits it into a chain of items
  - for each item (the `implement` workflow):
    - branch in a git worktree
    - implement
    - run the repo's checks
    - review
    - merge into `main` of your repo
  - verification of the result (for plans with more than one item)

When a merge changes the hatchling's own code, the supervisor restarts the daemon. If the new daemon cannot start, the supervisor reverts the merge.

## Authentication

The engine never handles credentials. Agents run through the Claude Agent SDK, which uses your existing Claude login (what the `claude` command created) or `ANTHROPIC_API_KEY`. Nothing in Ada Egg reads or stores either one.

Anthropic says, in its [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."

So Ada Egg offers no login of its own. If you are unsure whether your account may be used this way, an API key is the documented route. Use of the SDK is governed by Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms).

## Safety and cost

Read this before you ask for anything.

- Agents act with your own permissions, in your hatchling's repository. They can read and write files, run `npm`, `npx`, `node` and `git` (no push or remote changes) and the `hatch` script (`hatchling/bin/hatch` in the template) in Bash, and fetch and search the web. The exact list is in [hatchling/docs/system/agents.md](hatchling/docs/system/agents.md) and `hatchling/workflows/implement.yaml`.
- The UI listens on 127.0.0.1 only and has no login. Anyone who can reach 127.0.0.1 on your machine can queue work.
- Every request spends your own Claude usage: a planning run, one implement and review run per item, and a verification for plans with more than one item. Per-run caps exist (for example, an implement run is capped at 150 turns and about 10 US dollars), but they are the SDK's estimates and can overshoot. A large request can cost a lot.
- Review what lands in the repo's git history. Agents make mistakes, and their checks and reviews are not a guarantee.
- The supervisor reverts a merge that stops the hatchling from starting (see [hatchling/docs/system/restart-and-rollback.md](hatchling/docs/system/restart-and-rollback.md)). It cannot judge whether a change is a good idea.

## Working with your hatchling from a terminal

Inside your hatchling's folder, the `hatch` CLI manages the queue:

```
npm run hatch -- add "<title>" [--file <path>] [--kind item|request]
npm run hatch -- list
npm run hatch -- show <id>
npm run hatch -- status
npm run hatch -- retry <id>
npm start
npm run hatch -- stop
```

The hatchling's [AGENTS.md](hatchling/AGENTS.md) is written for LLM agents, such as an outside coding agent you point at your repo. Its guides and system docs are in [hatchling/docs/](hatchling/docs/system/queue.md).

## Developing Ada Egg itself

This repository holds the installer (`installer/`) and the template that `adaegg init` copies (`hatchling/`). It uses pnpm.

```
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm dev` serves only the template's UI, without the daemon, so API calls fail there. `pnpm scan:history` scans the whole git history for secrets and private names. Read the root [AGENTS.md](AGENTS.md) before changing anything.

## Not yet

- Other agent providers
- Sharing or templates between hatchlings
- An easier, non-terminal installer

## License

MIT, see [LICENSE](LICENSE).
