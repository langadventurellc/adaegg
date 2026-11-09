# The UI server

The daemon also serves a small local web server: a guarded JSON API and the browser UI. The code is in `src/server/`: `server.ts` (the `node:http` server), `guard.ts` (the request guard), `api.ts` (the routes) and `queue.ts` (the queue summary with `deliveryOf`, and titles). Vite runs in middleware mode and serves `index.html` and `src/ui/`, so the UI changes by editing source: the daemon needs no build step.

## Config and URL

In `adaegg.json`:

- `ui.enabled`: default `true`. When `false` the daemon starts no server.
- `ui.port`: each hatchling gets its own `ui.port`, written into `adaegg.json` at install (chosen from 4747-5746, stable for the life of the hatchling). A hatchling made before this keeps the `4747` default. `0` lets the OS pick a free port. When the port is taken, the server writes one line to stderr (`ui: this hatchling's usual address (port N) is busy because another program is using it, so it is on a temporary address this time`) and listens on a free port instead. That address is temporary: the next start tries the configured port again.

The server listens on `127.0.0.1` only. The daemon starts it after its first tick. Read the URL from the daemon's `hatchling UI: <url>` output, from `hatch status` (the `ui  <url>` line), or from `url` in `.adaegg/ready.json`. If the server fails to start, the daemon writes `daemon: UI failed to start: <message>` to stderr and carries on without a UI and without a `url`.

## API

All bodies are JSON. An error is `{ "error": "<message>" }` with status 400 (bad body), 404 (unknown path or id), 405 (wrong method), 409 (the status does not allow it), 413 (body over 64 KiB) or 415 (not JSON). API responses carry `Cache-Control: no-store`.

| Route | Body | Response |
| --- | --- | --- |
| `GET /api/state` | | 200 `{ name, queue }` (shapes below) |
| `POST /api/name` | `{ name }` | 200 `{ name }` with the cleaned name; 400 when the name is invalid |
| `POST /api/ask` | `{ text }` | 201 `{ id, title }`: creates a work item of kind `request` |
| `POST /api/items/<id>/retry` | `{}` | 200 `{ id, status }` with `status` `"queued"`; 404 unknown id; 409 when the item cannot be retried |
| `POST /api/items/<id>/cancel` | `{}` | 200 `{ id, status }` with `status` `"cancelled"`; 404 unknown id; 409 when the item cannot be cancelled |
| `GET /api/pages/<page>/data` | | 200 `{ items: { key, value, updatedAt }[] }`, ordered by key; 400 when `<page>` is not 1-64 letters, digits, `-` or `_` |
| `POST /api/pages/<page>/data/<key>` | `{ value }` (any JSON, including `null`) | 200 `{ key, value, updatedAt }`; 400 for a bad `<page>`, `<key>` or a body without `value`; 413 when the value is over 64 KiB |
| `POST /api/pages/<page>/data/<key>/delete` | `{}` | 200 `{ key }`; 400 for a bad `<page>` or `<key>`; 404 when the key does not exist |

`GET /api/state` shapes:

- `name`: `string | null`, the stored name or `null` when none is set.
- `queue.counts`: an object with one `number` per status (every status is present, zero included).
- `queue.requests`: an array of at most 20 rows, newest first. They are the top-level items (no parent) of kind `request` or `item`. Each row is:
  - `id: string`, the full id.
  - `title: string`.
  - `kind: "request" | "item"`.
  - `status: string`, one of the statuses in `counts`.
  - `error: string | null`.
  - `createdAt: string`, as stored.
  - `progress: { done: number, total: number } | null`: counts of the row's child items of kind `item` (`done` are those with status `done`); `null` when it has none. `verify` children are not counted.
  - `blockedBy: string[]`, ids of the items it waits for (empty when none).
  - `delivery: { state, attention } | null`: `null` for a row of kind `item`. For a `request`, `state` is `planning`, `building`, `verifying`, `delivered`, `needs-attention`, `incomplete`, `failed` or `cancelled`, derived by `deliveryOf` in `queue.ts` from the parent, its steps and its verifications. `attention` is `null` or `{ id, title, error, action }` naming the item that needs a human: `action` is `retry` for a failed or cancelled step or verification and for a failed or cancelled request, and `ask-again` for `incomplete` (verification gave up with work missing). `status` stays the parent item's status (a planned request is `done` while its steps are still queued), and `progress` still counts only step children.

Anything asked through `/api/ask` is a `request`, which the daemon plans into items and verifies (see [workflows](workflows.md)), so the user never writes a spec.

## The guard

Every request, API or Vite, passes `checkRequest` in `src/server/guard.ts` first:

- `Host` must be `localhost:<port>` or `127.0.0.1:<port>` (403 otherwise). This stops DNS rebinding, where a hostile page makes the browser send requests to 127.0.0.1 with its own hostname.
- Any method other than GET and HEAD needs `Content-Type: application/json` (415), and an `Origin` header, when present, must equal `http://<Host>` (403). A cross-site form or fetch cannot send JSON without a CORS preflight, and the server never answers preflights and sends no CORS headers.
- Only GET, HEAD and POST are allowed (405). This check comes last, so a PUT or DELETE without JSON gets 415 and one with a foreign Origin gets 403.

There is no login. Anyone who can open 127.0.0.1 on this machine can queue work, and agents run with the user's permissions.

## Screens

The page is plain TypeScript with no framework, in `src/ui/`:

- Onboarding: shown while no name is stored, and again from "Change name" (the heading then reads "Rename <name>" and the input is prefilled with the current name). It suggests a name from the names list (see [names](names.md)), with "Another suggestion" for more. The name is validated in the browser with `validateName`, and a server 400 shows the server's message inline.
- Ask: `Ask <name>` with a textarea, three starter requests (buttons that fill the textarea and never submit) and the "Your requests" list. Asking posts to `/api/ask`. Each request shows its `delivery` state (Building, Checking the result, Delivered, Needs attention, Incomplete) instead of Done. A row that needs attention names the failing step and has Retry on that step; an incomplete row has "Ask for the rest", which fills the textarea and never submits, and no Retry. Failed or cancelled requests have Retry, and queued rows have Cancel.
- While the server is unreachable (for example during the restart after a self-change) a "restarting" banner shows above the current screen and polling continues. The page never reloads itself; Vite's client does that when the daemon comes back.

The browser tab title is `Ask <name>` on the ask screen (and on the not-found message), the page's title on a page, and `Ada Egg` (the product name) during onboarding.

## Pages

Software built for the user lives in pages. The registry is `PAGES` in `src/ui/pages/index.ts`, a list of `{ id, title, render }` (empty in the template). `id` is the URL slug (lowercase kebab-case) and `render(root)` draws into `root` and may return a cleanup function. Each page lives in its own folder `src/ui/pages/<id>/`, with its pure logic in a tested module.

- Routes are by hash, parsed by `routeFor` in `view.ts`: `#/` (or empty) is the Ask screen, `#/<id>` is that page under a small header linking back to `Ask <name>`. An unknown id shows "This page doesn't exist." with the same link.
- Onboarding wins: while no name is set (or during a rename) onboarding shows whatever the hash is.
- The Ask screen lists the pages in a "Your pages" section above "Your requests", one link per page by title. With no pages the section is not shown.
- A page keeps its data in the hatchling's database, through the `page_data` table (`src/engine/page-data.ts`), the three `/api/pages/` routes and the `pageData(<page id>)` client in `src/ui/client.ts`, never in `localStorage` or files. Values are any JSON; each page owns its shape.
- Polling on a page refreshes only the banner, never the page. A page whose `render` throws shows the error text instead, and the shell keeps working.

## Files

| File | Role |
| --- | --- |
| `src/ui/main.ts` | The thin DOM shell: loads state, renders, delegates `data-action` clicks and form submits on `#app`, polls. |
| `src/ui/view.ts` | Pure rendering to HTML strings (`renderOnboarding`, `renderAsk`, `renderRequests`, `renderBanner`, `renderPageHeader`, `renderNotFound`, `renderPageError`), `describeDelivery` (the label for a delivery state), `screenFor` and `routeFor` (hash to route). |
| `src/ui/pages/index.ts` | The page registry `PAGES`, the `Page` type and `isPageId`. |
| `src/ui/state.ts` | Pure screen-state transitions, with the random source injected. |
| `src/ui/client.ts` | The typed API client (`ApiError`, `UnreachableError`). |
| `src/ui/starters.ts` | `STARTER_REQUESTS` and `pickStarters`. |
| `src/ui/style.css` | All styling. |

To change the starter requests, edit `STARTER_REQUESTS` in `src/ui/starters.ts` (keep 10 to 12 single-line entries of at most 120 characters). To change the look, edit `src/ui/style.css`; it uses CSS system colours so it follows the user's light or dark theme.

Polling runs every 3 seconds while the page is visible, and once when it becomes visible again. A poll replaces only the inner HTML of `#requests`, never the whole page, so text being typed and focus are kept. Polling never does a full render except when the screen changes or a late first suggestion arrives. A fetch that started before a finished action (Ask, Retry, Cancel, naming) is dropped as stale, and each action refreshes at once afterwards, so a slow poll can neither hide nor undo it (`Session` and `applyFetchResult` in `state.ts`).

Every user-visible string, whether from the user or the server (names, request titles, errors), goes through `escapeHtml` in `view.ts` before it is put in markup.

The pure modules (`view.ts`, `state.ts`, `client.ts`, `starters.ts`) are tested. The click and typing handlers in `main.ts` are not: the project has no DOM test environment, so keep `main.ts` a thin shell and put logic in the pure modules.

## State and restarts

Page data lives in the `page_data` table (`src/engine/page-data.ts`), so it survives restarts. The name lives in the `settings` table (`src/engine/settings.ts`), not in `adaegg.json`: changing a tracked file dirties the checkout the merge node needs clean.

A change under `src/` restarts the daemon after its merge, so the page is briefly unreachable (see [restart and rollback](restart-and-rollback.md)).
