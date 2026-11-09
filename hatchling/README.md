# Your hatchling

This repo is a hatchling: software that rewrites itself from your requests. It was built from Ada Egg, and from here on this repo is yours.

## Run it

```
npm start
```

This starts your hatchling and opens your browser; Ctrl-C stops it. To run it in the background instead, use `npm run hatch -- start --detach`, and `npm run hatch -- stop` to stop it. A coding agent pointed at this folder can start it too ("start my hatchling"), because `AGENTS.md` tells it how.

If the browser doesn't open, look for the line `hatchling UI: <url>` in the output (or run `npm run hatch -- status`) and open that address. Name your hatchling and ask for what you want. Agents use your Claude login (run `claude` once) or `ANTHROPIC_API_KEY`.

## For agents

`AGENTS.md` is the entry point: it explains the layout, the `hatch` CLI and the docs.

## Checks

`npm run check` runs lint, typecheck, tests and build. It must pass before any change is merged.

## State

`.adaegg/` holds the hatchling's state (its database and worktrees). It is git-ignored; never commit it.
