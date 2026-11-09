import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../engine/config.ts";
import { openDb } from "../engine/db.ts";
import { isPidAlive, readReady, readSupervisor } from "../engine/lifecycle.ts";
import { dbPath, findRepoRoot, stateDir } from "../engine/paths.ts";
import { listNodeRuns, listRuns, listRunsForItem, type NodeRun, type Run } from "../engine/runs.ts";
import { getSetting, setSetting } from "../engine/settings.ts";
import {
  addWorkItem,
  cancelWorkItem,
  getWorkItem,
  type ListedWorkItem,
  listWorkItems,
  retryWorkItem,
  type Status,
  type WorkItem,
} from "../engine/store.ts";
import { validateName } from "../names/validate.ts";
import { deliveryOf, progressOf } from "../server/queue.ts";
import { runSupervisor } from "../supervisor/supervisor.ts";

export type CliIo = {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  cwd: string;
  env?: NodeJS.ProcessEnv;
  // Lets tests stop a fake daemon instead of signalling a real one.
  stop?: {
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    isPidAlive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  };
  // Lets tests start no process and open no browser.
  start?: {
    open?: (url: string) => void | Promise<void>;
    spawn?: (args: SpawnArgs) => void;
    supervisor?: typeof runSupervisor;
    isPidAlive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
    pollMs?: number;
  };
};

export type SpawnArgs = {
  command: string;
  args: string[];
  cwd: string;
  logFile: string;
  env: NodeJS.ProcessEnv;
};

const STOP_POLL_MS = 200;
const STOP_TIMEOUT_MS = 60_000;
const START_POLL_MS = 200;
const START_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = 20;

const STATUSES: Status[] = ["queued", "in_progress", "done", "failed", "cancelled"];

export const HELP = `Usage: hatch <command> [options]

Commands:
  add "<title>" [--file <path>] [--kind item|request] [--blocked-by <id>]... [--parent <id>] [--priority <n>]
                        Queue a work item. Contents come from --file, else stdin
                        when it is not a terminal. A request is planned into a
                        chain of items by the daemon.
  list [--status <s>] [--json]
                        List work items. Statuses: ${STATUSES.join(", ")}.
  show <id> [--json]    Show one work item with its contents, blockers, runs
                        and node runs.
  runs [--limit n]      List the newest runs (default 20).
  cancel <id>           Cancel a queued item.
  retry <id>            Queue a failed or cancelled item again.
  status                Count items per status, say whether the supervisor and the
                        daemon are up and show the UI url when it is.
  name [<name>]         Show the hatchling's name, or set it.
  start [--detach] [--open]
                        Run the daemon under a supervisor that restarts it after
                        a change to the hatchling's own code. --detach runs it in
                        the background (log: <state>/logs/supervisor.log), waits
                        until it is up, prints its url and returns; running it
                        again while it is up is fine. --open opens the browser.
  stop                  Stop the hatchling: signals the supervisor (or the daemon
                        when it runs alone) and waits until both have exited.
                        Never reverts a merge.

Ids may be abbreviated to a prefix of at least 4 characters.
Options: -h, --help
`;

class UsageError extends Error {}

// Ends the command with this exit code and no further message.
class ExitCode extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const short = (id: string) => id.slice(0, 8);

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function parse<O extends Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }>>(
  args: string[],
  options: O,
) {
  try {
    return parseArgs({
      args,
      options: { ...options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function requireOne(positionals: string[], what: string): string {
  if (positionals.length === 0) throw new UsageError(`missing ${what}`);
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);
  return positionals[0] as string;
}

type StartDeps = {
  alive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
  pollMs: number;
};

function startDeps(io: CliIo): StartDeps {
  const d = io.start ?? {};
  return {
    alive: d.isPidAlive ?? io.stop?.isPidAlive ?? isPidAlive,
    sleep: d.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))),
    now: d.now ?? Date.now,
    timeoutMs: d.timeoutMs ?? START_TIMEOUT_MS,
    pollMs: d.pollMs ?? START_POLL_MS,
  };
}

// Polls until the daemon is up and has a url; null on timeout or when `signal.stopped` is set.
async function waitForUrl(dir: string, deps: StartDeps, signal: { stopped: boolean }): Promise<string | null> {
  const deadline = deps.now() + deps.timeoutMs;
  for (;;) {
    if (signal.stopped) return null;
    const ready = readReady(dir);
    if (ready?.url !== undefined && deps.alive(ready.pid)) return ready.url;
    if (deps.now() >= deadline) return null;
    await deps.sleep(deps.pollMs);
  }
}

const OPEN_WAIT_MS = 5_000;

// Rejects when the opener is missing, can't start or exits unsuccessfully, so openUrl prints the address.
export function defaultOpen(
  url: string,
  launch: typeof spawn = spawn,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  return new Promise((done, fail) => {
    const command = platform === "darwin" ? "open" : "xdg-open";
    const child = launch(command, [url], { detached: true, stdio: "ignore" });
    // An opener that stays up (a browser started in the foreground) has opened the page.
    const timer = setTimeout(() => {
      child.unref();
      done();
    }, OPEN_WAIT_MS);
    timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      fail(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else fail(new Error(`${command} exited with ${code}`));
    });
  });
}

// A failure to open never stops the hatchling: the address is printed instead.
async function openUrl(io: CliIo, url: string): Promise<void> {
  try {
    await (io.start?.open ?? defaultOpen)(url);
  } catch {
    io.stdout.write(`open this address in your browser: ${url}\n`);
  }
}

// Opens the browser once the daemon is ready; resolves when it has, or on timeout or `signal.stopped`.
export async function openWhenReady(io: CliIo, dir: string, signal: { stopped: boolean }): Promise<void> {
  const url = await waitForUrl(dir, startDeps(io), signal);
  if (url !== null) await openUrl(io, url);
}

function defaultSpawn({ command, args, cwd, logFile, env }: SpawnArgs): void {
  const logFd = openSync(logFile, "a");
  try {
    const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", logFd, logFd], env });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

function logTail(logFile: string, from: number): string {
  try {
    const text = readFileSync(logFile, "utf8");
    const own = Buffer.from(text).subarray(from).toString("utf8");
    return own
      .split("\n")
      .filter((l) => l !== "")
      .slice(-LOG_TAIL_LINES)
      .join("\n");
  } catch {
    return "";
  }
}

function describeBlocked(item: ListedWorkItem): string {
  if (item.status !== "queued" || item.blockedBy.length === 0) return "";
  return `  (blocked by ${item.blockedBy.map(short).join(", ")})`;
}

function childrenByParent(items: ListedWorkItem[]): Map<string, ListedWorkItem[]> {
  const map = new Map<string, ListedWorkItem[]>();
  for (const item of items) {
    if (item.parentId === null) continue;
    map.set(item.parentId, [...(map.get(item.parentId) ?? []), item]);
  }
  return map;
}

function describeDelivery(item: ListedWorkItem, children: ListedWorkItem[]): string {
  const progress = progressOf(children);
  return `${deliveryOf(item, children).state}${progress === null ? "" : ` ${progress.done}/${progress.total}`}`;
}

function formatItem(item: ListedWorkItem, children: ListedWorkItem[]): string {
  const delivery = item.kind === "request" ? `  ${describeDelivery(item, children)}` : "";
  return `${short(item.id)}  ${item.status}${delivery}  p${item.priority}  ${item.title}${describeBlocked(item)}\n`;
}

function formatNodeRun(n: NodeRun): string {
  const cost = n.costUsd === null ? "-" : `$${n.costUsd.toFixed(4)}`;
  return `    ${n.nodeId}  attempt ${n.attempt}  ${n.outcome ?? "-"}  problem: ${n.problem ?? "-"}  cost: ${cost}`;
}

function formatShow(item: ListedWorkItem, runs: (Run & { nodeRuns: NodeRun[] })[], children: ListedWorkItem[]): string {
  const lines = [
    `id: ${item.id}`,
    `title: ${item.title}`,
    `status: ${item.status}`,
    ...(item.kind === "request" ? [`delivery: ${describeDelivery(item, children)}`] : []),
    `kind: ${item.kind}`,
    `priority: ${item.priority}`,
    `parent: ${item.parentId ?? "-"}`,
    `blocked by: ${item.blockedBy.length > 0 ? item.blockedBy.join(", ") : "-"}`,
    `error: ${item.error ?? "-"}`,
    `created: ${item.createdAt}`,
    `updated: ${item.updatedAt}`,
    `finished: ${item.finishedAt ?? "-"}`,
    "contents:",
    item.contents,
  ];
  if (runs.length > 0) {
    lines.push("runs:");
    for (const run of runs) {
      lines.push(`  ${short(run.id)}  ${run.workflowId}  ${run.status}  ${run.currentNode ?? "-"}`);
      for (const n of run.nodeRuns) lines.push(formatNodeRun(n));
    }
  }
  return `${lines.join("\n")}\n`;
}

// `show` reports every blocker, not only unfinished ones, so it reads the table directly.
function withAllBlockers(db: ReturnType<typeof openDb>, item: WorkItem): ListedWorkItem {
  const rows = db.prepare("SELECT blocked_by_id FROM work_item_blocks WHERE item_id = ? ORDER BY rowid").all(item.id);
  return { ...item, blockedBy: rows.map((r) => r.blocked_by_id as string) };
}

async function runCommand(command: string, args: string[], io: CliIo): Promise<void> {
  const env = io.env ?? process.env;
  const out = (text: string) => io.stdout.write(text);

  switch (command) {
    case "add": {
      // parseArgs reads a separate `-1` as an option, so join it to its flag.
      const joined = args.flatMap((arg, i) => {
        if (/^-\d+$/.test(arg) && args[i - 1] === "--priority") return [];
        if (arg === "--priority" && /^-\d+$/.test(args[i + 1] ?? "")) return [`--priority=${args[i + 1]}`];
        return [arg];
      });
      const { values, positionals } = parse(joined, {
        file: { type: "string" },
        "blocked-by": { type: "string", multiple: true },
        parent: { type: "string" },
        priority: { type: "string" },
        kind: { type: "string" },
      });
      if (values.help) return void out(HELP);
      const title = requireOne(positionals, "title");
      if (values.kind !== undefined && values.kind !== "item" && values.kind !== "request")
        throw new UsageError(`--kind must be item or request, got ${values.kind}`);
      const kind = values.kind;
      let priority: number | undefined;
      if (values.priority !== undefined) {
        if (!/^-?\d+$/.test(values.priority))
          throw new UsageError(`--priority must be an integer, got ${values.priority}`);
        priority = Number(values.priority);
      }
      let contents = "";
      if (values.file !== undefined) {
        try {
          contents = readFileSync(resolve(io.cwd, values.file), "utf8");
        } catch {
          throw new UsageError(`cannot read file: ${values.file}`);
        }
      } else if (!io.stdin.isTTY) {
        contents = await readAll(io.stdin);
      }
      const db = openDb(dbPath(findRepoRoot(io.cwd), env));
      try {
        const item = addWorkItem(db, {
          title,
          contents,
          ...(priority === undefined ? {} : { priority }),
          ...(kind === undefined ? {} : { kind }),
          ...(values.parent === undefined ? {} : { parentId: values.parent }),
          ...(values["blocked-by"] === undefined ? {} : { blockedBy: values["blocked-by"] }),
        });
        out(`queued ${short(item.id)}\n`);
      } finally {
        db.close();
      }
      return;
    }
    case "list": {
      const { values, positionals } = parse(args, { status: { type: "string" }, json: { type: "boolean" } });
      if (values.help) return void out(HELP);
      if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
      if (values.status !== undefined && !STATUSES.includes(values.status as Status)) {
        throw new UsageError(`invalid status: ${values.status} (expected one of ${STATUSES.join(", ")})`);
      }
      const db = openDb(dbPath(findRepoRoot(io.cwd), env));
      try {
        const items = listWorkItems(db, values.status === undefined ? {} : { status: values.status as Status });
        if (values.json) return void out(`${JSON.stringify(items, null, 2)}\n`);
        // Delivery depends on every child, not only those the --status filter keeps.
        const children = childrenByParent(listWorkItems(db));
        out(items.map((item) => formatItem(item, children.get(item.id) ?? [])).join(""));
      } finally {
        db.close();
      }
      return;
    }
    case "show": {
      const { values, positionals } = parse(args, { json: { type: "boolean" } });
      if (values.help) return void out(HELP);
      const ref = requireOne(positionals, "id");
      const db = openDb(dbPath(findRepoRoot(io.cwd), env));
      try {
        const item = withAllBlockers(db, getWorkItem(db, ref));
        const runs = listRunsForItem(db, item.id).map((run) => ({ ...run, nodeRuns: listNodeRuns(db, run.id) }));
        const children = listWorkItems(db).filter((c) => c.parentId === item.id);
        out(values.json ? `${JSON.stringify({ ...item, runs }, null, 2)}\n` : formatShow(item, runs, children));
      } finally {
        db.close();
      }
      return;
    }
    case "runs": {
      const { values, positionals } = parse(args, { limit: { type: "string" } });
      if (values.help) return void out(HELP);
      if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
      let limit = 20;
      if (values.limit !== undefined) {
        if (!/^\d+$/.test(values.limit) || Number(values.limit) < 1)
          throw new UsageError(`--limit must be a positive integer, got ${values.limit}`);
        limit = Number(values.limit);
      }
      const db = openDb(dbPath(findRepoRoot(io.cwd), env));
      try {
        out(
          listRuns(db, { limit })
            .map(
              (r) => `${short(r.id)}  ${r.workflowId}  ${r.status}  ${r.currentNode ?? "-"}  ${short(r.workItemId)}\n`,
            )
            .join(""),
        );
      } finally {
        db.close();
      }
      return;
    }
    case "cancel":
    case "retry": {
      const { values, positionals } = parse(args, {});
      if (values.help) return void out(HELP);
      const ref = requireOne(positionals, "id");
      const db = openDb(dbPath(findRepoRoot(io.cwd), env));
      try {
        const item = command === "cancel" ? cancelWorkItem(db, ref) : retryWorkItem(db, ref);
        out(`${command === "cancel" ? "cancelled" : "queued"} ${short(item.id)}\n`);
      } finally {
        db.close();
      }
      return;
    }
    case "start": {
      const { values, positionals } = parse(args, { open: { type: "boolean" }, detach: { type: "boolean" } });
      if (values.help) return void out(HELP);
      if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
      const root = findRepoRoot(io.cwd);
      const dir = stateDir(root, env);
      const deps = startDeps(io);
      const recorded = readSupervisor(dir);
      const running = recorded !== null && deps.alive(recorded.pid);
      if (values.detach) {
        const logFile = join(dir, "logs", "supervisor.log");
        let logStart = 0;
        if (!running) {
          mkdirSync(join(dir, "logs"), { recursive: true });
          try {
            logStart = statSync(logFile).size;
          } catch {
            // No log yet.
          }
          (io.start?.spawn ?? defaultSpawn)({
            command: process.execPath,
            args: [fileURLToPath(import.meta.url), "start"],
            cwd: root,
            logFile,
            env,
          });
        }
        const url = await waitForUrl(dir, deps, { stopped: false });
        if (url === null) {
          io.stderr.write(
            `hatch: hatchling did not become ready within ${Math.round(deps.timeoutMs / 1000)}s; last log lines:\n`,
          );
          const tail = logTail(logFile, logStart);
          if (tail !== "") io.stderr.write(`${tail}\n`);
          throw new ExitCode(1);
        }
        const db = openDb(dbPath(root, env));
        let name: string;
        try {
          name = getSetting(db, "name") ?? "hatchling";
        } finally {
          db.close();
        }
        out(`${name} is running at ${url}\n`);
        if (values.open) await openUrl(io, url);
        return;
      }
      if (running) {
        throw new Error(`a hatchling is already running here (pid ${recorded.pid}); stop it with hatch stop`);
      }
      const signal = { stopped: false };
      const opened = values.open ? openWhenReady(io, dir, signal) : Promise.resolve();
      let code: number;
      try {
        code = await (io.start?.supervisor ?? runSupervisor)({
          root,
          stateDir: dir,
          config: loadConfig(root),
          stdout: io.stdout,
          stderr: io.stderr,
        });
      } finally {
        signal.stopped = true;
        await opened;
      }
      if (code !== 0) throw new ExitCode(code);
      return;
    }
    case "name": {
      const { values, positionals } = parse(args, {});
      if (values.help) return void out(HELP);
      if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);
      const wanted = positionals[0];
      const checked = wanted === undefined ? null : validateName(wanted);
      if (checked !== null && !checked.ok) throw new Error(checked.error);
      const db = openDb(dbPath(findRepoRoot(io.cwd), env));
      try {
        if (checked?.ok) {
          setSetting(db, "name", checked.name);
          out(`${checked.name}\n`);
        } else {
          out(`${getSetting(db, "name") ?? "(none)"}\n`);
        }
      } finally {
        db.close();
      }
      return;
    }
    case "status": {
      const { values, positionals } = parse(args, {});
      if (values.help) return void out(HELP);
      if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
      const root = findRepoRoot(io.cwd);
      const db = openDb(dbPath(root, env));
      try {
        const items = listWorkItems(db);
        out(STATUSES.map((s) => `${s}  ${items.filter((i) => i.status === s).length}\n`).join(""));
        const supervisor = readSupervisor(stateDir(root, env));
        if (supervisor !== null && isPidAlive(supervisor.pid)) out(`supervisor  up (pid ${supervisor.pid})\n`);
        const ready = readReady(stateDir(root, env));
        if (ready !== null && isPidAlive(ready.pid)) {
          out(`daemon  up (pid ${ready.pid})\n`);
          if (ready.url !== undefined) out(`ui  ${ready.url}\n`);
        } else {
          out("daemon  down\n");
        }
      } finally {
        db.close();
      }
      return;
    }
    case "stop": {
      const { values, positionals } = parse(args, {});
      if (values.help) return void out(HELP);
      if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
      const deps = io.stop ?? {};
      const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
      const alive = deps.isPidAlive ?? isPidAlive;
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
      const now = deps.now ?? Date.now;
      const timeoutMs = deps.timeoutMs ?? STOP_TIMEOUT_MS;
      const dir = stateDir(findRepoRoot(io.cwd), env);
      const supervisor = readSupervisor(dir);
      const ready = readReady(dir);
      // Signal the supervisor when there is one: SIGTERM to the daemon alone would count as a failed probation
      // and revert the merge. A daemon started alone has no supervisor and gets the signal itself.
      let target: { pid: number; what: string };
      if (supervisor !== null && alive(supervisor.pid)) target = { pid: supervisor.pid, what: "supervisor" };
      else if (ready !== null && alive(ready.pid)) target = { pid: ready.pid, what: "daemon" };
      else return void out("daemon  down\n");
      const waitFor = [{ ...target }];
      if (target.what === "supervisor" && ready !== null) waitFor.push({ pid: ready.pid, what: "daemon" });
      try {
        kill(target.pid, "SIGTERM");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
      const deadline = now() + timeoutMs;
      for (;;) {
        const pending = waitFor.find((p) => alive(p.pid));
        if (pending === undefined) break;
        if (now() >= deadline) {
          throw new Error(
            `${pending.what} (pid ${pending.pid}) did not stop within ${Math.round(timeoutMs / 1000)}s; if it is stuck, kill it by hand with: kill ${pending.pid}`,
          );
        }
        await sleep(STOP_POLL_MS);
      }
      out("stopped\n");
      return;
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    io.stdout.write(HELP);
    return 0;
  }
  if (command === undefined || command.startsWith("-") || !isCommand(command)) {
    io.stderr.write(HELP);
    return 1;
  }
  try {
    await runCommand(command, rest, io);
    return 0;
  } catch (err) {
    // The supervisor has already printed its message.
    if (err instanceof ExitCode) return err.code;
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, " ").trim();
    io.stderr.write(`hatch: ${message}\n`);
    return 1;
  }
}

export const COMMANDS = ["add", "list", "show", "runs", "cancel", "retry", "status", "name", "start", "stop"];

function isCommand(name: string): boolean {
  return COMMANDS.includes(name);
}

export async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    cwd: process.cwd(),
    env: process.env,
  });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  await main();
}
