# Your hatchling

This repo is a hatchling: software that rewrites itself from your requests. It was built from Ada Egg, and from here on this repo is yours.

## Run it

```
npm start
```

Look for the line `hatchling UI: <url>` in the output (or run `npm run hatch -- status`), open that address, name your hatchling and ask for what you want. Agents use your Claude login (run `claude` once) or `ANTHROPIC_API_KEY`.

## For agents

`AGENTS.md` is the entry point: it explains the layout, the `hatch` CLI and the docs.

## Checks

`npm run check` runs lint, typecheck, tests and build. It must pass before any change is merged.

## State

`.adaegg/` holds the hatchling's state (its database and worktrees). It is git-ignored; never commit it.
