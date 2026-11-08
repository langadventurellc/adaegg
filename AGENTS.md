# adaegg

## Product

To be written from the project brief.

## Stack

- TypeScript, strict.
- Vite for the browser app, Vitest for tests.
- Biome for lint and formatting.
- pnpm, with Node 24 from `mise.toml`.

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
