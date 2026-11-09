# Restart and rollback

## Why there is a supervisor

The daemon runs from the code its own merges change (`src/`, `workflows/`, `prompts/`, `bin/` and the package files). After such a merge the running daemon is stale, and a merge that breaks startup would leave a dead hatchling with nothing left to fix it. `hatch start` (also `npm start`) runs the daemon under a supervisor (`src/supervisor/supervisor.ts`) that restarts it after a self-change and reverts the merge if the new daemon does not come up healthy. `npm run daemon` runs the daemon alone: it never restarts or rolls back.

## The restart request

When a run succeeds and its merge changed `src/`, `workflows/`, `prompts/`, `bin/`, `package.json`, `package-lock.json` or `adaegg.json`, the daemon writes `<state>/restart.json`, stops claiming, waits for the other in-flight runs and exits with code **75**. A merge that touched only other paths (docs, for example) requests nothing.

| Field | Meaning |
| --- | --- |
| `mergeCommit` | the merge on the base branch (the newest covered merge, if the request covers several) |
| `workItemId` | the item that was merged (that of `mergeCommit`) |
| `preMergeHead` | the first parent of the oldest covered merge |
| `requestedAt` | ISO timestamp |
| `earlier` | optional: other merges the same restart covers (`{ mergeCommit, workItemId }`) |

Every self-change stays covered. While `restart.json` exists the daemon claims nothing (the supervisor is still judging the previous self-change). If a run finishes a self-changing merge while a request is pending (several runs draining, or a resumed run during probation), the daemon adds it to the request: `mergeCommit` becomes the newest merge, `preMergeHead` is the first parent of the oldest covered merge (whatever order the runs finish in), and the rest go in `earlier`. The supervisor only deletes the request it started the daemon for, never a newer one.

## Readiness

Once the workflows are loaded, the database is open and the first tick is done, the daemon writes `<state>/ready.json` (`{ pid, startedAt, head }`). It deletes it on a clean exit, and the supervisor deletes it before every start. `hatch status` prints `daemon  up` when `ready.json` exists and its pid is alive.

## The supervisor loop

Each start: delete `ready.json`; if `restart.json` exists and `package.json` or `package-lock.json` changed between `preMergeHead` and `mergeCommit`, run the `setup` command from `adaegg.json` in the main checkout; spawn `node src/daemon/main.ts` in the repo root, appending its output to `<state>/logs/daemon.log`. Exit 0 ends the supervisor with 0. Exit 75 starts again at once. Any other exit restarts after 2s.

SIGINT/SIGTERM to the supervisor send SIGTERM to the daemon, wait for it (then kill it) and exit.

The supervisor records its pid in `<state>/supervisor.json` while it runs and deletes it on every exit; `hatch stop` signals the supervisor and not the daemon, so a stop never reverts a merge (a daemon that exits on probation without a stop still fails probation).

## Probation

While `restart.json` exists the new daemon is on probation. It must write `ready.json` within 30s and then stay up for 60s (the defaults). Once stable, the supervisor deletes `restart.json`: it moves the file aside (to a private `restart.json.consuming`), compares and deletes only that copy, and puts a different request back without overwriting one written in the meantime, so a request written while it clears the old one is never lost. A daemon that exits at any point on probation, or is not ready in time, fails probation and the supervisor rolls back.

## Rollback

At most one rollback happens per restart request, and it never discards work that isn't the reverted merge. `git reset` is never used: `git revert` adds a commit, so no history is lost.

A `setup` that fails (non-zero or no exit status) before the new daemon starts counts as a failed start and rolls back too.

1. It reads the current `restart.json` (it may have grown). If the main checkout is not on `baseBranch` (another branch, or a detached HEAD), the supervisor prints that to stderr and exits 1 without reverting or deleting the request.
2. If the main checkout has changes outside `.adaegg/`, the supervisor prints the files and `git status` to stderr and exits 1 without reverting.
3. It deletes `restart.json` (so a supervisor killed mid-rollback and restarted reverts nothing a second time), then runs `git revert -m 1 --no-edit <mergeCommit>` for each covered merge, newest first (without `-m 1` if the commit has one parent, as when the merge fast-forwarded). If a revert fails it runs `git revert --abort`, prints the error and exits 1 (after recording the merges already reverted, step 4).
4. It marks each reverted work item `failed` (it was `done`) with the error "Its merge stopped the hatchling from restarting, so it was reverted. Last daemon output: <last 20 lines>". If that fails (for example the item was retried meanwhile) the error is printed and the rollback goes on.
5. If the package files changed between `preMergeHead` and `mergeCommit`, it runs `setup` again. If that fails the supervisor exits 1; the revert and the failed items are already recorded.
6. It starts the daemon again with no restart pending.

## The crash-loop bound

A daemon that exits with an error 3 times within 60s while no restart is pending makes the supervisor print `the hatchling won't start; see <state>/logs/daemon.log` and exit 1. This is what ends a second failure after a rollback.

## Diagnosing a hatchling that won't start

Read, in this order:

1. `<state>/logs/daemon.log`: the daemon's output, newest last.
2. `<state>/restart.json`: present while a self-change merge is on probation.
3. `<state>/ready.json`: present while a daemon is up.
4. `<state>/supervisor.json`: present while a supervisor runs.
5. `git log --first-parent <base>`: the merge and, after a rollback, its `Revert` commit.

`<state>` is `.adaegg/` unless `ADAEGG_STATE_DIR` is set.
