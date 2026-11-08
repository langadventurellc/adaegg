import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openDb } from "../engine/db.ts";
import { dbPath, findRepoRoot } from "../engine/paths.ts";
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

export type CliIo = {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

const STATUSES: Status[] = ["queued", "in_progress", "done", "failed", "cancelled"];

const HELP = `Usage: hatch <command> [options]

Commands:
  add "<title>" [--file <path>] [--blocked-by <id>]... [--parent <id>] [--priority <n>]
                        Queue a work item. Contents come from --file, else stdin
                        when it is not a terminal.
  list [--status <s>] [--json]
                        List work items. Statuses: ${STATUSES.join(", ")}.
  show <id> [--json]    Show one work item with its contents and blockers.
  cancel <id>           Cancel a queued item.
  retry <id>            Queue a failed or cancelled item again.
  status                Count items per status.

Ids may be abbreviated to a prefix of at least 4 characters.
Options: -h, --help
`;

class UsageError extends Error {}

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

function describeBlocked(item: ListedWorkItem): string {
  if (item.status !== "queued" || item.blockedBy.length === 0) return "";
  return `  (blocked by ${item.blockedBy.map(short).join(", ")})`;
}

function formatItem(item: ListedWorkItem): string {
  return `${short(item.id)}  ${item.status}  p${item.priority}  ${item.title}${describeBlocked(item)}\n`;
}

function formatShow(item: ListedWorkItem): string {
  const lines = [
    `id: ${item.id}`,
    `title: ${item.title}`,
    `status: ${item.status}`,
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
      });
      if (values.help) return void out(HELP);
      const title = requireOne(positionals, "title");
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
        out(values.json ? `${JSON.stringify(items, null, 2)}\n` : items.map(formatItem).join(""));
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
        out(values.json ? `${JSON.stringify(item, null, 2)}\n` : formatShow(item));
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
    case "status": {
      const { values, positionals } = parse(args, {});
      if (values.help) return void out(HELP);
      if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
      const db = openDb(dbPath(findRepoRoot(io.cwd), env));
      try {
        const items = listWorkItems(db);
        out(STATUSES.map((s) => `${s}  ${items.filter((i) => i.status === s).length}\n`).join(""));
      } finally {
        db.close();
      }
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
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, " ").trim();
    io.stderr.write(`hatch: ${message}\n`);
    return 1;
  }
}

function isCommand(name: string): boolean {
  return ["add", "list", "show", "cancel", "retry", "status"].includes(name);
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
