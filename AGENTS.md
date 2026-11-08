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

## Commands

```
pnpm install
pnpm dev         # Vite dev server
pnpm lint        # Biome: lint, formatting and import order, warnings fail it; changes nothing
pnpm format      # fix what Biome can fix automatically
pnpm typecheck
pnpm test
pnpm build
```

## Conventions

- ESM, strict TypeScript.
- Small, focused modules.
- Write tests with every change.

Before considering any change done: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` must pass.
