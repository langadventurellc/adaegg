import { realpathSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Ask } from "./choices.ts";
import { InitError, runInit } from "./init.ts";

export type CliIo = {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  cwd: string;
  env: NodeJS.ProcessEnv;
  isInteractive?: boolean;
  ask?: Ask;
  closeInput?: () => void;
};

export const HELP = `Usage: adaegg init [<dir>] [--name <name>] [--dir <dir>] [--no-start] [--skip-check]
                        Create your own hatchling repo. In a terminal it asks for a name
                        and a folder (--name and --dir, or <dir>, answer for you); the
                        folder defaults to one named after the hatchling under the current
                        directory. It copies the template, installs it, sets the name,
                        commits it, runs the repo's own checks, then starts the hatchling
                        and opens your browser. --no-start stops after installing;
                        --skip-check skips the checks.
       adaegg --help    Show this help.
`;

class UsageError extends Error {}

function parse(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        name: { type: "string" },
        dir: { type: "string" },
        "no-start": { type: "boolean" },
        "skip-check": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
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
    if (positionals.length > 0 && values.dir !== undefined) {
      throw new UsageError("give the folder either as <dir> or as --dir, not both");
    }
    return await (deps.runInit ?? runInit)(
      {
        name: values.name,
        dir: values.dir ?? positionals[0],
        skipCheck: values["skip-check"] === true,
        noStart: values["no-start"] === true,
      },
      {
        cwd: io.cwd,
        env: io.env,
        stdout: io.stdout,
        stderr: io.stderr,
        isInteractive: io.isInteractive,
        ask: io.ask,
        closeInput: io.closeInput,
      },
    );
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
  const prompt = readlinePrompt();
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      stdout: process.stdout,
      stderr: process.stderr,
      cwd: process.cwd(),
      env: process.env,
      isInteractive: process.stdin.isTTY === true,
      ask: prompt.ask,
      closeInput: prompt.close,
    });
  } finally {
    prompt.close();
  }
}

// Opens the readline interface on the first question, so a run that never asks leaves stdin alone.
function readlinePrompt(): { ask: Ask; close: () => void } {
  let rl: Interface | undefined;
  return {
    ask: (question) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      const active = rl;
      return new Promise<string>((resolvePromise, reject) => {
        const onClose = () => reject(new InitError("Input ended before the questions were answered."));
        active.once("close", onClose);
        active.question(question).then(
          (answer) => {
            active.off("close", onClose);
            resolvePromise(answer);
          },
          (err: unknown) => reject(err),
        );
      });
    },
    close: () => rl?.close(),
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  await main();
}
