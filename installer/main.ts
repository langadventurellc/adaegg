import { parseArgs } from "node:util";
import { runInit } from "./init.ts";

export type CliIo = {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export const HELP = `Usage: adaegg init [<dir>] [--skip-check]
                        Create your own hatchling repo in <dir> (default: hatchling):
                        copy the template, install it and commit it. --skip-check
                        skips running the new repo's own checks.
       adaegg --help    Show this help.
`;

class UsageError extends Error {}

function parse(args: string[]) {
  try {
    return parseArgs({
      args,
      options: { "skip-check": { type: "boolean" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

export async function runCli(argv: string[], io: CliIo, deps: { runInit?: typeof runInit } = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    io.stdout.write(HELP);
    return 0;
  }
  try {
    if (command === undefined) throw new UsageError("missing command");
    if (command !== "init") throw new UsageError(`unknown command: ${command}`);
    const { values, positionals } = parse(rest);
    if (values.help) {
      io.stdout.write(HELP);
      return 0;
    }
    if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);
    await (deps.runInit ?? runInit)(
      { dir: positionals[0] ?? "hatchling", skipCheck: values["skip-check"] === true },
      { cwd: io.cwd, env: io.env, stdout: io.stdout, stderr: io.stderr },
    );
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`adaegg: ${err.message}\n${HELP}`);
      return 1;
    }
    io.stderr.write(`adaegg: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export async function main(): Promise<void> {
  const version = process.versions.node;
  if (Number(version.split(".")[0]) < 24) {
    process.stderr.write(`Ada Egg needs Node 24 or newer; this is Node ${version}.\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    env: process.env,
  });
}
