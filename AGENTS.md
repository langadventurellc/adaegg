# adaegg

## Product

Ada Egg is an MIT-licensed, open-source tool for growing personal software: each install creates a blank-slate, self-rewriting “hatchling” built on Ada's foundations, which becomes bespoke software as its user describes what they want. A setup command creates the user's own repository (local-only is fine), which the hatchling rewrites; users do not normally clone this repository. A small UI focuses on onboarding and an **Ask \<name\>** prompt with suggested requests. Onboarding lets users choose a product or person's name, never suggests “Ada”, and suggests distinctive first names (or surnames when first names are too common) from contributors to AI, information theory, computer science, philosophy, post-modern thought, poetry and literature, balanced across genders, nationalities, races and ethnicities and deliberately not dominated by Western Europeans. An unobtrusive daemon runs a work item queue, a cron-style scheduler and built-in workflows: an implement cycle with review and checks to keep the hatchling working, plus milestone workflows that split larger requests into chains of items; agents can chain requests by default. A CLI lets outside agents do anything the shipped features support, and the hatchling's repository contains documentation for LLM agents to use, support and change it. Hatchlings should be able to rewrite themselves into almost anything while staying much simpler than Ada: they build themselves, not other products, and do not need production-grade release machinery. This repository is public: never include private infrastructure, hosts, secrets or internal tools, and write its README for a stranger discovering the project.

Later versions may add other agent providers, sharing or templates between hatchlings, and an easier non-terminal installer. Do not build these now.

## Stack

- TypeScript, strict.
- Node 24 for the runtime; users need only Node, git and a Claude login, with no Postgres, Docker, Kubernetes or mise requirement.
- SQLite for the work item queue and run records.
- Claude Agent SDK only for agents; no other model providers in v1.
- Vite for the browser app, Vitest for tests.
- Biome for lint and formatting.
- pnpm, with Node 24 from `mise.toml` for repository development.

## Layout

- The repository root is Ada Egg's own development repo (pnpm, Biome, Vitest).
- `README.md` is the public README for strangers; `LICENSE` is the MIT license.
- `hatchling/` is the template that a setup command copies into a user's repo; it uses npm and has its own `biome.jsonc` and `tsconfig.json`.
- `installer/` is the `adaegg init` source, compiled to `dist/installer` for publishing because Node does not strip types under `node_modules`.
- `bin/adaegg.mjs` is the published `adaegg` entry; it imports the compiled `dist/installer/main.js`.
- `scripts/` holds the public-repo scanner (`public-scan.ts`) and the `scan:history` script.
- There is no pnpm workspace. Root devDependencies hold everything the template uses, and `tests/template-pin.test.ts` pins the template's versions to them.

## Commands

```
pnpm install
pnpm dev         # Vite dev server for the template UI (hatchling/)
pnpm lint        # Biome on the root, then on hatchling/ with its own config: lint, formatting and import order, warnings fail it; changes nothing
pnpm format      # fix what Biome can fix automatically, in both
pnpm typecheck   # tsc on hatchling/tsconfig.json; also covers installer/
pnpm test        # Vitest from the root, including hatchling/**/*.test.ts
pnpm build       # typecheck, then vite build into hatchling/dist; also compiles installer/ into dist/installer
pnpm scan:history  # scan the whole git history for secrets and private names; run before making the repo public
```

`pnpm dev` serves only the template's front end from Vite, without the daemon, so API calls fail there.

## Conventions

- ESM, strict TypeScript.
- Small, focused modules.
- Write tests with every change.
- Keep README.md true: its quick start and safety section must match the installer and `hatchling/docs/system/agents.md`.
- This repository is public. `tests/public-repo.test.ts` fails on secret-shaped strings, private hosts, IPs, home paths, internal tool names and unknown email addresses. To add a private term, add its ROT13 form to `scripts/public-scan.ts`; never write the term itself in a file or commit message.

Before considering any change done: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` must pass.
