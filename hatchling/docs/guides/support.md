# Support a hatchling

You read this when a hatchling is not working (it will not start, an item failed, work is stuck, or the disk is filling) and you must find the cause and the next step.

Start from the symptom. `<state>` is `.adaegg/`, or `$ADAEGG_STATE_DIR` when that is set. `<run8>` is the first 8 characters of a run id.

| Symptom | Run or read | Usual fix |
| --- | --- | --- |
| The daemon is down or will not start | `hatch status`; `<state>/logs/daemon.log`; `<state>/restart.json`; `<state>/ready.json`; `git log --first-parent` on the base branch | See [the daemon will not start](#the-daemon-will-not-start) |
| An item is `failed` | `hatch show <id>`: the error, and the failing node run's problem; then the transcript `<state>/logs/<run8>/<node id>-<attempt>.jsonl` | Fix the cause the problem names, then `hatch retry <id>` |
| An item failed with `blocked` because Claude is not signed in | `hatch show <id>` (problem: `Claude isn't signed in`); [agents](../system/agents.md), Results | Run `claude` once to log in, or set `ANTHROPIC_API_KEY` for the daemon, then `hatch retry <id>` |
| The error is `loop <from>:<on> exceeded its limit of <max>` | `hatch show <id> --json`: in each run's `state`, read `findings` (review) and `checkOutput` (checks); plain `hatch show` omits both | The item bounced between nodes too often. Fix the cause (a failing check, a repeated review finding) or make the item smaller, then `hatch retry <id>` |
| A merge is `blocked`: the main checkout is dirty or not on the base branch | `hatch show <id>` names what to clean up; `git status` in the main checkout | Commit or discard the changes and switch to the base branch (`.adaegg/` is ignored), then `hatch retry <id>` |
| An item stays `queued` | `hatch show <id>` lists its blockers | If a blocker is `failed` or `cancelled`, fix it and `hatch retry` the blocker; the item then proceeds |
| A request is `failed` at planning (the planner found nothing, or gave no valid plan) | `hatch show <id>`, then the planner transcript | Queue the work as items with `hatch add`, or write a clearer request |
| Work is missing after the verification limit (`maxVerifyRounds`) | The root request stays `done` in the database, and Ask shows it as "Incomplete" with an "Ask for the rest" button; the child `verify` item is the one that `failed`. Find it with `hatch list --status failed --json` (`kind` is `verify`, `parentId` is the request id), then `hatch show <verify-id>`: the error names the titles the verifier wanted. `hatch show <request-id>` does not show this error | Queue those titles as items, or as a new request |
| A schedule did not fire | See [a schedule did not fire](#a-schedule-did-not-fire) | |
| The disk is growing | See [disk growth](#disk-growth) | |

## The daemon will not start

1. Read `.adaegg/logs/daemon.log` (or `$ADAEGG_STATE_DIR/logs/daemon.log`) for the daemon's last output.
2. Look at `.adaegg/restart.json` (a self-change merge on probation) and `.adaegg/ready.json` (a daemon is up).
3. Run `git log --first-parent` on the base branch: a rolled-back change shows as the merge followed by a `Revert` commit. Never use `git reset` to undo it.
4. If the supervisor exited 1 with "the checkout has uncommitted changes", the main checkout was dirty, so nothing was reverted: commit or discard those changes, then revert the merge by hand with `git revert -m 1 <mergeCommit>` (the hash is in `restart.json`, if still there, or `git log --first-parent`).
5. A reverted item is `failed` with the daemon output in its error. To bring it back, fix the cause and run `hatch retry <id>`.

If the daemon prints workflow problems and exits 1, a file in `workflows/` is invalid: the output names the file and each problem (see [workflows](../system/workflows.md), Load-time checks). How restarts and rollbacks work is in [restart and rollback](../system/restart-and-rollback.md).

## The UI does not load

1. Get the URL from `hatch status` (the `ui` line). If the default port was in use, the server fell back to a free one, so check the URL rather than assuming 4747.
2. Look in the daemon's stderr (`.adaegg/logs/daemon.log`) for `UI failed to start`; the daemon keeps running without a UI then.
3. Check that `ui.enabled` is not `false` in `adaegg.json`.
4. After a self-change merge the daemon restarts and the page is briefly down; reload in a few seconds.

See [ui](../system/ui.md).

## A schedule did not fire

1. Schedules use the machine's local time, not UTC.
2. The first time the daemon sees a cron workflow it fires nothing; it records the time and fires from the next slot.
3. Nothing fires while `restart.json` exists, so check that first.
4. Nothing fires while an item of that kind (for example `tidy`) is still `queued` or `in_progress`: run `hatch list --status queued` and `hatch list --status in_progress`.
5. The `schedules` table in `<state>/hatch.db` has `last_checked_at` per workflow. Only read it (for example with a read-only SQLite query); never write to it. If it is later than the slot you expected, the slot was already handled.

See the `cron` trigger in [workflows](../system/workflows.md).

## Disk growth

The `tidy` item removes only:

- the worktree and `hatch/` branch of each `done` item whose branch is merged into the base branch;
- log directories under `<state>/logs/` older than `retainLogDays` (default 30) that do not belong to a running run.

It never removes the worktrees or branches of `failed`, `cancelled` or unfinished items, because a retry continues in that worktree. Retry such items to finish them. Only the daily `tidy` item frees disk, so a worktree of a failed item stays until you deal with the item.

## Never do

- **`git reset` on the base branch.** It discards history that the daemon, the queue and other worktrees refer to. Undo a merge with `git revert -m 1 <mergeCommit>`, which adds a commit.
- **Edit `.adaegg/` or the database by hand.** The daemon and the queue assume they own those files; a manual edit can corrupt a run or make the daemon resume the wrong node. Use `hatch cancel` and `hatch retry`.
- **Run two daemons on one repo.** They would claim and merge concurrently, and each would restart or roll back the other's work. Check `hatch status` shows `daemon  down` before starting one.
