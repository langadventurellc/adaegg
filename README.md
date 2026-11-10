# Ada Egg

Ada Egg gives people a tool for growing their own software. Each install hatches a *hatchling*: a small self-rewriting system that starts blank and, when you ask, rewrites itself into software for you and nobody else. You describe what you want in plain language; agents change the hatchling's own repository to provide it. Ada Egg is built on the foundations of Ada, an engine that builds software the same way, much simplified.

Repository: https://github.com/langadventurellc/adaegg

## Status

Early: version 0.1.0. Tested on Linux. macOS should work. Windows is untested.

## What you need

- Node 24 or newer
- git
- curl or wget, for the install line
- A Claude login (what the `claude` command creates) or `ANTHROPIC_API_KEY`

Nothing else: no pnpm, Postgres, Docker, Kubernetes or mise. A hatchling itself needs only npm, and its queue is the built-in `node:sqlite`.

## Quick start

```
curl -fsSL https://raw.githubusercontent.com/langadventurellc/adaegg/main/install.sh | bash
```

It asks for a name and a folder, installs your hatchling there, starts it and opens your browser on `Ask <name>`. The install line works once the repository is public.

To start it again later, run `cd <folder> && npm start`, or ask your coding agent to start it. You can run the install line again to hatch another one: each lives in its own folder and has its own fixed address, printed at the end of the install and by `hatch status`.

The name you give is set during the install, so onboarding is skipped. A hatchling installed by an older version has no name yet, and its onboarding screen still asks for one (it suggests a name, never "Ada", and you may type anything). The screen is `Ask <name>` with some suggested starter requests. Pick one or write your own.

`adaegg init [<dir>] [--name <name>] [--dir <dir>] [--no-start] [--skip-check]` creates your own repository. The install line runs it for you; to pass options, add them after `bash -s --`. In a terminal it asks for a name (suggesting one) and a folder; `--name` and `--dir` (or `<dir>`, the same thing) answer for you. Without a terminal it never asks: the name is `--name` or a suggestion, and the folder defaults to a folder named after the hatchling under the current directory. It:

- copies the hatchling template into the folder;
- runs `git init` on branch `main`;
- sets a local git identity only when you have none;
- turns commit and tag signing off in that repo, because agents cannot answer a passphrase prompt;
- runs `npm install`;
- sets the hatchling's name;
- makes the first commit;
- runs the hatchling's own `npm run check` (`--skip-check` skips this); a failed check keeps the hatchling, writes `.adaegg/logs/install-check.log` and doesn't start it;
- starts the hatchling and opens your browser (`--no-start` stops after installing).

The repository is local only. Nothing is pushed anywhere. You may add your own remote later.

## How a request becomes software

Everything you ask becomes a *request*. A planner agent splits it into a chain of items, and each item goes through the `implement` workflow. A verification then checks the result. What you ask for shows up as a page under "Your pages" on the Ask screen.

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

- Agents act with your own permissions, in your hatchling's repository. They can read and write files, run `npm`, `npx`, `node`, `git` (no push or remote changes), `ls`, `mkdir` and the `hatch` script (`hatchling/bin/hatch` in the template) in Bash, and fetch and search the web. Only those commands are approved; everything else in Bash is denied. This is not a sandbox: `npm`, `npx` and `node` can run arbitrary code with your permissions, so the deny rules for git push and remotes stop the usual forms of those commands but are not a guarantee against remote changes. The exact list is in [hatchling/docs/system/agents.md](hatchling/docs/system/agents.md) and `hatchling/workflows/implement.yaml`.
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
npm run hatch -- name <name>
npm start
npm run hatch -- start --detach
npm run hatch -- stop
```

The hatchling's [AGENTS.md](hatchling/AGENTS.md) is written for LLM agents, such as an outside coding agent you point at your repo. Its guides and system docs are in [hatchling/docs/](hatchling/docs/).

## Developing Ada Egg itself

This repository holds the installer (`installer/`) and the template that `adaegg init` copies (`hatchling/`). It uses pnpm.

To try the installer from a clone, no pnpm install or build is needed:

```
node installer/main.ts init ../my-hatchling
```

`ADAEGG_SOURCE=. sh install.sh ../my-hatchling` tests the install script from a clone.

To work on the repository itself:

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
