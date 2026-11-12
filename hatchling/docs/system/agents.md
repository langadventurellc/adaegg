# Agent nodes

Agent nodes run Claude through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The code is `src/engine/nodes/agent.ts`. `createAgentNode({ query })` takes the SDK's `query` function as a parameter, so tests pass a fake and no test or check calls the real SDK or needs a login. `nodes/index.ts` registers the real one.

## Node types

One implementation is registered as two node types, because a node type fixes its outcomes:

- **`agent`** (`done`, `failed`, `blocked`): runs the prompt and finishes.
- **`review`** (`approve`, `changes`, `failed`, `blocked`): the same code with `output` forced to `verdict`.

As for every node, a workflow needs an edge for each outcome.

## Config

| Key | Meaning |
| --- | --- |
| `prompt` | Path of the role prompt, relative to the repo root, inside `prompts/`. A path that escapes `prompts/` makes the node `blocked`. |
| `model` | `implement` or `review`: a key of `models` in `adaegg.json`. The alias (default `sonnet` for both) comes from the config the daemon loads once at startup, so after changing `models` in `adaegg.json` restart the daemon. |
| `tools` | Tool names to allow (`Read`, `Edit`, …). |
| `bash` | Bash command patterns to allow. Each becomes `Bash(<pattern>)`, for example `git *`. |
| `deny` | Rules to deny, written as the SDK does (`Bash(git push*)`). |
| `maxTurns`, `maxBudgetUsd` | Passed to the SDK. The budget is the SDK's own estimate and can overshoot. |
| `output` | `text` (default), `verdict` or `plan`. `verdict` is for the `review` type (forced there); `plan` is for the `agent` type. |
| `cwd` | `worktree` (default) or `root`: the main checkout, for read-only agents such as the planner. `commit: true` with `cwd: root` is a config error. |
| `commit` | `false` by default. `true` turns on the commit guard (below). |

The prompt sent is `buildPrompt(promptText, workItem, state)`: the role text, the work item's title, `Work item id:` and (when the run has one) `Base branch:` lines, and its contents, then "Check output", "Review findings" and "Merge conflicts" sections for whatever the run state holds (`checkOutput`, `findings`, `conflictFiles`).

## Tools: an allowlist that denies the rest

The SDK is called with `cwd` set to the run's worktree, or to the repo root with `cwd: root` (the node is `blocked` if the run has no worktree and `cwd` is `worktree`; with `cwd: root` it needs none), `allowedTools` (`tools` plus a `Bash(...)` entry per `bash` pattern), `disallowedTools` (`deny`), `settingSources: ['project']` (the repo's own `CLAUDE.md` and skills apply, the user's personal settings do not) and an abort controller tied to the run's signal.

`allowedTools` only auto-approves; it does not restrict. A tool that is not listed would fall through to a permission prompt, and nobody answers a prompt in a daemon: the run would hang. So the node sets `permissionMode: 'dontAsk'`, which denies anything not pre-approved. The `deny` rules are scoped and apply in every mode. `bypassPermissions` is never used.

A bare `Bash` in `tools` approves every command and so defeats the `bash` patterns. The shipped workflows therefore list only `bash` patterns, never `Bash` in `tools` (the Bash tool is still available; the patterns approve matching commands). The shipped implement workflow has no `rm` or `mv`, so agents use `git rm` and `git mv`.

A pattern list is a gate on the commands Claude writes, not a security boundary or a sandbox (see <https://code.claude.com/docs/en/permissions>). Compound commands are split on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, and each part must match an allow rule. Wrappers such as `timeout` and `nice` are stripped before matching. Deny rules cover the usual forms of a command, not every way to invoke it (`git -C . push` may not match `Bash(git push*)`). Allowed programs such as `node` can run arbitrary code with the user's permissions.

## Environment and chaining

`env` replaces the subprocess environment, so the node passes `{ ...process.env, ADAEGG_STATE_DIR: <absolute state dir> }` and nothing else is added or removed. `ADAEGG_STATE_DIR` makes `bin/hatch` run by the agent inside its worktree use the main queue, not a copy in the worktree. An agent chains follow-up work with `bin/hatch add "<title>" --file <spec> --blocked-by <this item's id>`.

## Verdicts

A `review` node asks the SDK for structured output (`outputFormat: { type: 'json_schema' }`) shaped `{ verdict: 'approve' | 'changes', findings: string[] }` and reads `structured_output` from the result. If that is absent it parses the last fenced `json` block of the result text. The object is validated with Zod and `findings` must be non-empty for `changes`. `approve` sets `state.findings` to `[]`; `changes` sets it to the findings. A missing or invalid verdict is `failed` with the problem `review gave no verdict`.

## Plans

With `output: plan` the node asks the SDK for structured output with `PLAN_JSON_SCHEMA` (`src/engine/plan.ts`) and reads `structured_output` from the result, else the last fenced `json` block of the result text. The object is validated with `PlanSchema` (item count, keys, and `dependsOn` naming only earlier items). A valid plan is stored in `state.plan` and the outcome is `done`. A missing or invalid plan is `failed` with the problem `the agent gave no valid plan: <issue>` (`no JSON found` when there is none). Cost and tokens are recorded as for the other outputs.

### Read-only rule for `cwd: root`

An agent with `cwd: root` shares the main checkout with the daemon, and the `merge` node refuses a dirty main checkout. Such an agent must only have read tools (`Read`, `Glob`, `Grep`) and read-only Bash patterns (`git log*`, `git show*`, `git diff*`, `git status*`, `ls *`), never `Write`, `Edit`, `NotebookEdit` or a command that changes anything.

## Results

- A `success` result is `done` (or the verdict outcomes).
- `error_max_turns`, `error_during_execution`, `error_max_budget_usd` and `error_max_structured_output_retries` are `failed`, the problem being the subtype plus the SDK's `errors`.
- An authentication failure (an assistant message with `error: 'authentication_failed'`, or an error result that says so) is `blocked` with the problem ``Claude isn't signed in. Run `claude` once to log in, or set ANTHROPIC_API_KEY, then `hatch retry` this item.``
- The result's `total_cost_usd` and token usage are recorded on the node run.
- If the run's signal aborts, the node stops reading the SDK and throws; the runner leaves the run `running` for the next start.

## Authentication

The engine never handles credentials. No code reads, writes, logs, stores, prompts for or copies a credential, and nothing touches `~/.claude`. The SDK gets `process.env` unchanged and finds the user's existing Claude login (what `claude` created) or `ANTHROPIC_API_KEY` itself. Anthropic does not allow third-party products to offer claude.ai login, so the engine offers none; a user who is not signed in gets the `blocked` guidance above.

## Transcripts

Each attempt appends JSON lines to `<state dir>/logs/<first 8 characters of the run id>/<node id>-<attempt>.jsonl`: one line per assistant text, tool use (`name`, `input`) and tool result. Tool input and output are cut at 2000 characters. The attempt is the node's attempt number in the run.

## Chat agent

The chat agent (`src/server/chat.ts`, role text in `prompts/chat.md`) turns what the user says into one request. It is not a workflow node and is not queued: a turn runs in the UI server process, so it never waits behind a build. `createChatRunner({ db, root, stateDir, appConfig, query })` takes the SDK's `query` as a parameter, as the agent node does.

- **Model:** `models.chat` (default `sonnet`).
- **Tools:** `Read`, `Glob`, `Grep`, `Bash(git log*)`, `Bash(git show*)`, `Bash(git diff*)`, `Bash(git status*)` and `Bash(ls *)`, with `permissionMode: 'dontAsk'`, `settingSources: ['project']`, `maxTurns: 12` and `maxBudgetUsd: 0.5`. It runs with `cwd: root`, so the Read-only rule above applies: no `Write`, `Edit` or bare `Bash`.
- **Prompt:** the role text, the earlier conversation, a digest of up to 20 queue rows (so the agent needs no `hatch` command) and the latest message.
- **Output:** structured output `{ reply, request? }` (else the last fenced `json` block), validated with Zod. A valid `request` is queued with the reply in one transaction. Invalid or missing output fails the turn.
- **Sign-in:** detected as in the agent node (an `authentication_failed` assistant message, or an error result matching the same pattern); the turn fails with sign-in guidance. The runner handles no credentials.
- **Time and stop:** a turn is aborted after 3 minutes, or when the server stops, and is failed with a message that says so.
- **Transcript and cost:** JSON lines in `<state dir>/logs/chat/<reply id>.jsonl`, cut as for agent transcripts; the `tidy` workflow's log cleanup removes old directories under `logs/`. The turn's cost is stored on the reply message (`cost_usd`).

## Commit guard

With `commit: true`, after the agent reports `done` the node checks the worktree. If `git status --porcelain` is not empty it runs `git add -A` and commits with `hatch: <title> (<id8>)`. If `git rev-list --count --no-merges <base>..HEAD` is 0, so the branch has no commits of its own (merging an advanced base into an untouched branch adds none, and commits already in base do not count), the outcome is `failed` with the problem `the implement step made no changes`. Running the node twice is safe: a clean worktree makes no commit. The guard does not clear `checkOutput`, `findings` or `conflictFiles`.
