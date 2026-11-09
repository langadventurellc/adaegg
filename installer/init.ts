import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Ask, chooseDir, chooseName, loadNames } from "./choices.ts";

export class InitError extends Error {}

export const GITIGNORE = "node_modules/\ndist/\n.adaegg/\n";

const MIN_NODE_MAJOR = 24;
const TAIL_LINES = 40;

export type InitOptions = { name?: string; dir?: string; skipCheck: boolean; noStart: boolean };

export type NpmResult = { ok: boolean; output: string };

export type RunNode = (
  args: string[],
  cwd: string,
  mode: "capture" | "inherit",
) => Promise<{ code: number; output: string }>;

export type InitDeps = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  nodeVersion?: string;
  templateDir?: string;
  npm?: (args: string[], cwd: string) => Promise<NpmResult>;
  isInteractive?: boolean;
  ask?: Ask;
  // Called once no more questions will be asked, before the hatchling starts, so a terminal
  // left in raw mode by the prompt does not swallow the child's Ctrl-C.
  closeInput?: () => void;
  home?: string;
  random?: () => number;
  runNode?: RunNode;
};

// Copies the template into `target` without build output, state or the template's own git data,
// then writes the .gitignore (not copied: npm has dropped or renamed it in published packages).
export function copyTemplate(templateDir: string, target: string): void {
  cpSync(templateDir, target, {
    recursive: true,
    filter: (src) => {
      const parts = relative(templateDir, src).split(sep);
      if (parts.some((part) => part === "node_modules" || part === "dist" || part === ".adaegg")) return false;
      if (parts.length === 1 && (parts[0] === "package-lock.json" || parts[0] === ".git")) return false;
      return true;
    },
  });
  writeFileSync(join(target, ".gitignore"), GITIGNORE);
}

// Walks up from `from` to the nearest ancestor holding hatchling/adaegg.json.
export function findTemplateDir(from: string): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "hatchling", "adaegg.json"))) return join(dir, "hatchling");
    const parent = dirname(dir);
    if (parent === dir) throw new InitError(`Cannot find the hatchling template above ${from}; reinstall adaegg.`);
    dir = parent;
  }
}

function realNpm(env: NodeJS.ProcessEnv): (args: string[], cwd: string) => Promise<NpmResult> {
  return (args, cwd) =>
    new Promise((resolvePromise) => {
      let output = "";
      const child = spawn("npm", args, { cwd, env, shell: false });
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      child.on("error", (err) => resolvePromise({ ok: false, output: err.message }));
      child.on("close", (code) => resolvePromise({ ok: code === 0, output }));
    });
}

function realRunNode(env: NodeJS.ProcessEnv): RunNode {
  return (args, cwd, mode) =>
    new Promise((resolvePromise) => {
      let output = "";
      const child = spawn(process.execPath, args, {
        cwd,
        env,
        stdio: mode === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        output += String(chunk);
      });
      child.on("error", (err) => resolvePromise({ code: 1, output: err.message }));
      child.on("close", (code) => resolvePromise({ code: code ?? 1, output }));
    });
}

function tail(output: string): string {
  return output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function quoteIfSpaced(path: string): string {
  return path.includes(" ") ? `"${path}"` : path;
}

export async function runInit(options: InitOptions, deps: InitDeps): Promise<number> {
  const out = (text: string) => deps.stdout.write(`${text}\n`);
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, env: deps.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  if (Number(nodeVersion.split(".")[0]) < MIN_NODE_MAJOR) {
    throw new InitError(`Ada Egg needs Node ${MIN_NODE_MAJOR} or newer; this is Node ${nodeVersion}.`);
  }
  try {
    git(deps.cwd, "--version");
  } catch {
    throw new InitError("git is required; install it from https://git-scm.com and try again.");
  }

  const templateDir = deps.templateDir ?? findTemplateDir(dirname(fileURLToPath(import.meta.url)));
  const names = await loadNames(templateDir);
  const interactive = deps.isInteractive === true && deps.ask !== undefined;
  const ask: Ask = deps.ask ?? (async () => "");
  const name = await chooseName({
    name: options.name,
    interactive,
    ask,
    out: (text) => deps.stdout.write(`${text}\n`),
    suggestion: names.suggest(deps.random),
    validate: names.validate,
  });
  const chosen = await chooseDir({
    dir: options.dir,
    name,
    cwd: deps.cwd,
    home: deps.home ?? deps.env.HOME ?? homedir(),
    interactive,
    ask,
    out: (text) => deps.stdout.write(`${text}\n`),
  });
  deps.closeInput?.();
  const target = chosen.dir;
  let probe = target;
  try {
    if (existsSync(target)) {
      if (!statSync(target).isDirectory() || readdirSync(target).length > 0) {
        throw new InitError(`${target} is not empty; pick a new or empty folder.`);
      }
    } else {
      probe = dirname(target);
      while (!existsSync(probe)) probe = dirname(probe);
      if (!statSync(probe).isDirectory()) {
        throw new InitError(`${probe} is a file, so ${target} cannot be created inside it; pick another folder.`);
      }
    }
  } catch (err) {
    if (err instanceof InitError) throw err;
    throw new InitError(
      `Cannot inspect ${target}: ${errorText(err)}. Check the path and its permissions, then try again.`,
    );
  }
  let top: string | undefined;
  try {
    top = git(probe, "rev-parse", "--show-toplevel");
  } catch {
    top = undefined;
  }
  if (top !== undefined) {
    throw new InitError(`${target} is inside the git repository ${top}; pick a folder outside it.`);
  }

  const npm = deps.npm ?? realNpm(deps.env);
  const runNode = deps.runNode ?? realRunNode(deps.env);

  out(`Creating ${name} in ${target} …`);
  try {
    mkdirSync(target, { recursive: true });
    copyTemplate(templateDir, target);

    git(target, "init");
    git(target, "symbolic-ref", "HEAD", "refs/heads/main");
    const configured = (key: string): string => {
      try {
        return git(target, "config", key);
      } catch {
        return "";
      }
    };
    if (configured("user.name") === "" || configured("user.email") === "") {
      git(target, "config", "user.name", "Hatchling");
      git(target, "config", "user.email", "hatchling@localhost");
      out("Note: no git identity is configured, so this repo commits as Hatchling <hatchling@localhost>.");
    }
    git(target, "config", "commit.gpgsign", "false");
    git(target, "config", "tag.gpgsign", "false");
    out(
      "Note: commit and tag signing are turned off in this repo, because agent commits cannot answer a passphrase prompt.",
    );

    out("Installing dependencies; this takes a minute or two...");
    const install = await npm(["install", "--no-audit", "--no-fund"], target);
    if (!install.ok) throw new InitError(`npm install failed:\n${tail(install.output)}`);

    const named = await runNode(["src/cli/main.ts", "name", name], target, "capture");
    if (named.code !== 0) throw new InitError(`Setting the name failed:\n${tail(named.output)}`);

    git(target, "add", "-A");
    git(target, "commit", "-m", "Create hatchling");

    if (!options.skipCheck) {
      out("Running the hatchling's own checks...");
      const check = await npm(["run", "check"], target);
      if (!check.ok) {
        const logPath = join(target, ".adaegg", "logs", "install-check.log");
        let logged = true;
        try {
          mkdirSync(dirname(logPath), { recursive: true });
          writeFileSync(logPath, check.output);
        } catch {
          logged = false;
        }
        out("");
        out(`${name} was created in ${target}, but its self-check didn't pass on this machine.`);
        out("This often happens on a busy machine right after install.");
        out(logged ? `The full output is in ${logPath}` : "The full output could not be saved to a log file.");
        out(`Run the check again with: cd ${quoteIfSpaced(target)} && npm run check`);
        out("You can also start it anyway with `npm start` in that folder.");
        return 1;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr).trim() : "";
    const detail = err instanceof InitError || stderr === "" ? message : `${message}\n${stderr}`;
    throw new InitError(`${detail}\nThe folder ${target} was left in place for you to inspect.`);
  }

  out("");
  out(`${name} is ready in ${target}`);
  out("Agents use your Claude login (run `claude` once) or ANTHROPIC_API_KEY; Ada Egg never handles either.");
  out(`Start it again later: cd ${quoteIfSpaced(target)} && npm start, or ask your coding agent to start it.`);
  if (options.noStart) return 0;
  out("");
  const started = await runNode(["src/cli/main.ts", "start", "--open"], target, "inherit");
  return started.code;
}
