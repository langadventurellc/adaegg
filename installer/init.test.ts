import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { folderFor, loadNames } from "./choices.ts";
import {
  findTemplateDir,
  GITIGNORE,
  type InitDeps,
  InitError,
  type InitOptions,
  runInit as realRunInit,
} from "./init.ts";

// Most tests only care about installing, so they default to not starting the hatchling.
const runInit = (options: Partial<InitOptions>, deps: InitDeps) =>
  realRunInit({ skipCheck: false, noStart: true, ...options }, deps);

const templateDir = join(dirname(fileURLToPath(import.meta.url)), "..", "hatchling");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix = "adaegg-init-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

type Npm = NonNullable<InitDeps["npm"]>;

type RunNodeCall = { args: string[]; cwd: string; mode: string };

function setup(
  opts: {
    globalConfig?: string;
    failOn?: "install" | "check";
    failLines?: number;
    nameFails?: boolean;
    startCode?: number;
  } = {},
) {
  const home = tmp("adaegg-home-");
  const globalFile = join(home, "gitconfig");
  writeFileSync(globalFile, opts.globalConfig ?? "");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalFile,
  };
  const cwd = tmp();
  const calls: { args: string[]; cwd: string }[] = [];
  const out: string[] = [];
  const npm: Npm = async (args, at) => {
    calls.push({ args, cwd: at });
    const kind = args[0] === "install" ? "install" : "check";
    if (opts.failOn === kind) {
      const lines = Array.from({ length: opts.failLines ?? 60 }, (_, i) => `line ${i + 1}`);
      return { ok: false, output: `${lines.join("\n")}\n` };
    }
    if (kind === "install") writeFileSync(join(at, "package-lock.json"), '{"lockfileVersion":3}\n');
    return { ok: true, output: "" };
  };
  const nodeCalls: RunNodeCall[] = [];
  const order: string[] = [];
  const runNode: NonNullable<InitDeps["runNode"]> = async (args, at, mode) => {
    nodeCalls.push({ args, cwd: at, mode });
    order.push(`node ${args[1]}`);
    if (args[1] === "name" && opts.nameFails) return { code: 1, output: "name boom\n" };
    if (args[1] === "start") return { code: opts.startCode ?? 0, output: "" };
    return { code: 0, output: "" };
  };
  const trackedNpm: Npm = async (args, at) => {
    order.push(`npm ${args[0]}`);
    return npm(args, at);
  };
  const deps: InitDeps = {
    cwd,
    env,
    stdout: { write: (t) => out.push(t) },
    stderr: { write: (t) => out.push(t) },
    templateDir,
    npm: trackedNpm,
    isInteractive: false,
    home,
    random: () => 0,
    runNode,
    isPortFree: async () => true,
  };
  return { deps, env, cwd, home, calls, nodeCalls, order, out, text: () => out.join("") };
}

describe("runInit", () => {
  it("creates the target from the template", async () => {
    const s = setup();
    await runInit({ dir: "mine", skipCheck: false }, s.deps);
    const target = join(s.cwd, "mine");
    for (const f of [
      "adaegg.json",
      "package.json",
      "bin/hatch",
      "AGENTS.md",
      "workflows/implement.yaml",
      "README.md",
      "package-lock.json",
    ]) {
      expect(existsSync(join(target, f)), f).toBe(true);
    }
    for (const f of ["node_modules", "dist", ".adaegg"]) expect(existsSync(join(target, f)), f).toBe(false);
    expect(readFileSync(join(target, ".gitignore"), "utf8")).toBe(GITIGNORE);
    expect(GITIGNORE).toBe(readFileSync(join(templateDir, ".gitignore"), "utf8"));
  });

  it("writes the chosen port into adaegg.json and keeps the other keys", async () => {
    const s = setup();
    const tpl = tmp("adaegg-tpl-");
    mkdirSync(join(tpl, "src", "names"), { recursive: true });
    for (const f of ["names.ts", "suggest.ts", "validate.ts"]) {
      writeFileSync(join(tpl, "src", "names", f), readFileSync(join(templateDir, "src", "names", f)));
    }
    writeFileSync(join(tpl, "adaegg.json"), '{"schema":1,"extra":"kept","ui":{"open":true}}');
    const busy = new Set<number>();
    const isPortFree = async (port: number) => !busy.has(port);
    const deps = { ...s.deps, templateDir: tpl, isPortFree };
    await runInit({ dir: "one", skipCheck: true }, deps);
    const first = JSON.parse(readFileSync(join(s.cwd, "one", "adaegg.json"), "utf8"));
    expect(first.schema).toBe(1);
    expect(first.extra).toBe("kept");
    expect(first.ui.open).toBe(true);
    expect(Number.isInteger(first.ui.port)).toBe(true);
    expect(first.ui.port).toBeGreaterThanOrEqual(4747);
    expect(first.ui.port).toBeLessThanOrEqual(5746);
    busy.add(first.ui.port);
    await runInit({ dir: "two", skipCheck: true }, deps);
    const second = JSON.parse(readFileSync(join(s.cwd, "two", "adaegg.json"), "utf8"));
    expect(second.ui.port).not.toBe(first.ui.port);
  });

  it("fails as an InitError when no port is free", async () => {
    const s = setup();
    const err = await runInit({ dir: "mine", skipCheck: true }, { ...s.deps, isPortFree: async () => false }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InitError);
    expect((err as Error).message).toContain("no free port");
  });

  it("does not copy a template's node_modules, dist, .adaegg, lock or .git", async () => {
    const s = setup();
    const tpl = tmp("adaegg-tpl-");
    for (const p of ["node_modules/x", "dist/y", "src/dist/z", ".adaegg/w", ".git/HEAD"]) {
      mkdirSync(dirname(join(tpl, p)), { recursive: true });
      writeFileSync(join(tpl, p), "x");
    }
    mkdirSync(join(tpl, "src", "names"), { recursive: true });
    for (const f of ["names.ts", "suggest.ts", "validate.ts"]) {
      writeFileSync(join(tpl, "src", "names", f), readFileSync(join(templateDir, "src", "names", f)));
    }
    writeFileSync(join(tpl, "package-lock.json"), "{}");
    writeFileSync(join(tpl, "adaegg.json"), "{}");
    mkdirSync(join(tpl, "keep"));
    writeFileSync(join(tpl, "keep", "package-lock.json"), "{}");
    await runInit({ dir: "mine", skipCheck: true }, { ...s.deps, templateDir: tpl });
    const target = join(s.cwd, "mine");
    for (const p of ["node_modules", "dist", "src/dist", ".adaegg"]) expect(existsSync(join(target, p)), p).toBe(false);
    expect(readFileSync(join(target, "package-lock.json"), "utf8")).toBe('{"lockfileVersion":3}\n');
    expect(existsSync(join(target, "keep", "package-lock.json"))).toBe(true);
    // the only .git is the one init made
    expect(git(target, s.env, "rev-parse", "--show-toplevel")).toBe(target);
  });

  it("makes a clean repo on main with one commit that tracks the lock", async () => {
    const s = setup();
    await runInit({ dir: "mine", skipCheck: false }, s.deps);
    const target = join(s.cwd, "mine");
    expect(git(target, s.env, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(target, s.env, "log", "--format=%s")).toBe("Create hatchling");
    expect(git(target, s.env, "status", "--porcelain")).toBe("");
    expect(git(target, s.env, "ls-files", "package-lock.json")).toBe("package-lock.json");
  });

  it("sets a local identity when none is configured, and turns signing off", async () => {
    const s = setup();
    await runInit({ dir: "mine", skipCheck: true }, s.deps);
    const target = join(s.cwd, "mine");
    expect(git(target, s.env, "config", "--local", "user.name")).toBe("Hatchling");
    expect(git(target, s.env, "config", "--local", "user.email")).toBe("hatchling@localhost");
    expect(git(target, s.env, "config", "--local", "commit.gpgsign")).toBe("false");
    expect(git(target, s.env, "config", "--local", "tag.gpgsign")).toBe("false");
    expect(s.text()).toContain("Hatchling");
  });

  it("keeps a global identity and still turns signing off", async () => {
    const s = setup({ globalConfig: "[user]\n\tname = Zed\n\temail = z@example.com\n[commit]\n\tgpgsign = true\n" });
    await runInit({ dir: "mine", skipCheck: true }, s.deps);
    const target = join(s.cwd, "mine");
    expect(() => git(target, s.env, "config", "--local", "user.name")).toThrow();
    expect(git(target, s.env, "config", "--local", "commit.gpgsign")).toBe("false");
    expect(git(target, s.env, "config", "--local", "tag.gpgsign")).toBe("false");
    expect(git(target, s.env, "log", "--format=%an")).toBe("Zed");
  });

  it("runs npm install then the check, or only install with skipCheck", async () => {
    const s = setup();
    await runInit({ dir: "mine", skipCheck: false }, s.deps);
    const target = join(s.cwd, "mine");
    expect(s.calls).toEqual([
      { args: ["install", "--no-audit", "--no-fund"], cwd: target },
      { args: ["run", "check"], cwd: target },
    ]);
    const t = setup();
    await runInit({ dir: "mine", skipCheck: true }, t.deps);
    expect(t.calls.map((c) => c.args)).toEqual([["install", "--no-audit", "--no-fund"]]);
  });

  it("reports the last 40 lines of a failed install", async () => {
    const s = setup({ failOn: "install" });
    const err = await runInit({ dir: "mine", skipCheck: false }, s.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InitError);
    const message = (err as Error).message;
    expect(message).toContain("line 60");
    expect(message).toContain("line 21");
    expect(message).not.toContain("line 20\n");
    expect(message).not.toContain("line 1\n");
    expect(message).toContain("left in place");
    expect(existsSync(join(s.cwd, "mine"))).toBe(true);
  });

  it("reports a failed check and keeps the commit", async () => {
    const s = setup({ failOn: "check" });
    const target = join(s.cwd, "mine");
    const code = await runInit({ dir: "mine", skipCheck: false }, s.deps);
    expect(code).not.toBe(0);
    expect(git(target, s.env, "log", "--format=%s")).toBe("Create hatchling");
    expect(git(target, s.env, "status", "--porcelain")).toBe("");
    const logPath = join(target, ".adaegg", "logs", "install-check.log");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("line 1\n");
    expect(log).toContain("line 60");
    const text = s.text();
    expect(text).toContain(logPath);
    expect(text).toContain("npm run check");
    expect(text).toContain("npm start");
    expect(text).not.toContain("left in place");
  });

  it("refuses a non-empty folder and an existing file", async () => {
    const s = setup();
    mkdirSync(join(s.cwd, "full"));
    writeFileSync(join(s.cwd, "full", "a"), "x");
    writeFileSync(join(s.cwd, "file"), "x");
    await expect(runInit({ dir: "full", skipCheck: true }, s.deps)).rejects.toThrow("is not empty");
    await expect(runInit({ dir: "file", skipCheck: true }, s.deps)).rejects.toThrow("is not empty");
    expect(s.calls).toEqual([]);
  });

  it("explains a target whose parent is a file, and creates nothing", async () => {
    const s = setup();
    writeFileSync(join(s.cwd, "file"), "x");
    const err = await runInit({ dir: "file/child", skipCheck: true }, s.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InitError);
    expect((err as InitError).message).toContain("is a file");
    expect(s.calls).toEqual([]);
    expect(readFileSync(join(s.cwd, "file"), "utf8")).toBe("x");
  });

  it("wraps a failure to create the target in an InitError", async () => {
    const s = setup();
    mkdirSync(join(s.cwd, "ro"), { mode: 0o500 });
    if (process.getuid?.() === 0) return; // root ignores directory modes
    const err = await runInit({ dir: "ro/child", skipCheck: true }, s.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InitError);
    expect((err as InitError).message).toContain("was left in place");
  });

  it("refuses a folder inside another git repository", async () => {
    const s = setup();
    const repo = tmp("adaegg-outer-");
    git(repo, s.env, "init");
    mkdirSync(join(repo, "sub"));
    const deps = { ...s.deps, cwd: repo };
    await expect(runInit({ dir: "sub", skipCheck: true }, deps)).rejects.toThrow("is inside the git repository");
    await expect(runInit({ dir: "sub/new/deeper", skipCheck: true }, deps)).rejects.toThrow(
      "is inside the git repository",
    );
  });

  it("refuses old Node", async () => {
    const s = setup();
    await expect(runInit({ dir: "mine", skipCheck: true }, { ...s.deps, nodeVersion: "22.5.0" })).rejects.toThrow(
      "22.5.0",
    );
  });

  it("needs git", async () => {
    const s = setup();
    await expect(runInit({ dir: "mine", skipCheck: true }, { ...s.deps, env: { ...s.env, PATH: "" } })).rejects.toThrow(
      "git is required",
    );
  });

  it("accepts an empty existing folder and a missing nested one", async () => {
    const s = setup();
    mkdirSync(join(s.cwd, "empty"));
    await runInit({ dir: "empty", skipCheck: true }, s.deps);
    await runInit({ dir: "a/b/c", skipCheck: true }, s.deps);
    expect(existsSync(join(s.cwd, "empty", "adaegg.json"))).toBe(true);
    expect(existsSync(join(s.cwd, "a", "b", "c", "adaegg.json"))).toBe(true);
  });

  it("prints what to do next", async () => {
    const s = setup();
    await runInit({ dir: "mine", skipCheck: false }, s.deps);
    const text = s.text();
    for (const word of ["Start it again later: cd ", "npm start", "ask your coding agent", "ANTHROPIC_API_KEY"]) {
      expect(text).toContain(word);
    }
    expect(text).not.toContain("hatchling UI");
  });

  it("quotes a path with a space in the cd line", async () => {
    const s = setup();
    await runInit({ dir: "my hatchling", skipCheck: true }, s.deps);
    expect(s.text()).toContain(`cd "${join(s.cwd, "my hatchling")}"`);
  });
});

function answers(list: string[]) {
  const asked: string[] = [];
  const ask = async (question: string) => {
    asked.push(question);
    const next = list.shift();
    if (next === undefined) throw new Error(`unexpected question: ${question}`);
    return next;
  };
  return { ask, asked };
}

describe("runInit name and folder", () => {
  it("asks for both and takes the suggestions on Enter", async () => {
    const s = setup();
    const suggestion = (await loadNames(templateDir)).suggest(() => 0);
    const a = answers(["", ""]);
    await runInit({}, { ...s.deps, isInteractive: true, ask: a.ask });
    const target = join(s.cwd, folderFor(suggestion));
    expect(a.asked).toEqual([
      `Name your hatchling [${suggestion}]: `,
      `Where should ${suggestion} live? [${target}]: `,
    ]);
    expect(existsSync(join(target, "adaegg.json"))).toBe(true);
    expect(s.nodeCalls[0]?.args).toEqual(["src/cli/main.ts", "name", suggestion]);
    expect(s.text()).toContain(`Creating ${suggestion} in ${target}`);
  });

  it("treats a missing ask as non-interactive", async () => {
    const s = setup();
    await runInit({ name: "Pip" }, { ...s.deps, isInteractive: true });
    expect(existsSync(join(s.cwd, "pip", "adaegg.json"))).toBe(true);
  });

  it("re-asks an invalid name with the validation error", async () => {
    const s = setup();
    const a = answers(["3pip", "Pip", ""]);
    await runInit({}, { ...s.deps, isInteractive: true, ask: a.ask });
    expect(a.asked.filter((q) => q.startsWith("Name your hatchling"))).toHaveLength(2);
    const rejected = (await loadNames(templateDir)).validate("3pip");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(s.text()).toContain(rejected.error);
    expect(existsSync(join(s.cwd, "pip", "adaegg.json"))).toBe(true);
  });

  it("re-asks a folder that is not empty", async () => {
    const s = setup();
    mkdirSync(join(s.cwd, "taken"));
    writeFileSync(join(s.cwd, "taken", "a"), "x");
    const a = answers(["Pip", "taken", "free"]);
    await runInit({}, { ...s.deps, isInteractive: true, ask: a.ask });
    expect(s.text()).toContain("is not empty");
    expect(existsSync(join(s.cwd, "free", "adaegg.json"))).toBe(true);
  });

  it("expands ~ to the home directory", async () => {
    const s = setup();
    const a = answers(["Pip", "~/x"]);
    await runInit({}, { ...s.deps, isInteractive: true, ask: a.ask });
    expect(existsSync(join(s.home, "x", "adaegg.json"))).toBe(true);
  });

  it("without a terminal creates ./<slug>, then ./<slug>-2 when that is taken", async () => {
    const s = setup();
    await runInit({ name: "Pip Moss" }, s.deps);
    expect(existsSync(join(s.cwd, "pip-moss", "adaegg.json"))).toBe(true);
    await runInit({ name: "Pip Moss" }, s.deps);
    expect(existsSync(join(s.cwd, "pip-moss-2", "adaegg.json"))).toBe(true);
  });

  it("rejects an explicit dir that is not empty", async () => {
    const s = setup();
    mkdirSync(join(s.cwd, "pip-moss"));
    writeFileSync(join(s.cwd, "pip-moss", "a"), "x");
    await expect(runInit({ name: "Pip Moss", dir: "pip-moss" }, s.deps)).rejects.toThrow("is not empty");
  });
});

describe("runInit name command and start", () => {
  it("sets the name through the repo's CLI after npm install and before the commit", async () => {
    const s = setup();
    await runInit({ name: "Pip Moss", dir: "mine" }, s.deps);
    const target = join(s.cwd, "mine");
    expect(s.nodeCalls).toEqual([{ args: ["src/cli/main.ts", "name", "Pip Moss"], cwd: target, mode: "capture" }]);
    expect(s.order).toEqual(["npm install", "node name", "npm run"]);
    expect(git(target, s.env, "log", "--format=%s")).toBe("Create hatchling");
  });

  it("reports a failing name command with its output", async () => {
    const s = setup({ nameFails: true });
    const err = await runInit({ name: "Pip", dir: "mine" }, s.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InitError);
    expect((err as Error).message).toContain("Setting the name failed:\nname boom");
    expect((err as Error).message).toContain("left in place");
  });

  it("does not start with noStart", async () => {
    const s = setup();
    expect(await runInit({ name: "Pip", dir: "mine", noStart: true }, s.deps)).toBe(0);
    expect(s.nodeCalls.some((c) => c.args[1] === "start")).toBe(false);
    expect(s.text()).toContain("Start it again later:");
  });

  it("starts last with inherited stdio and returns its exit code", async () => {
    const s = setup({ startCode: 3 });
    expect(await runInit({ name: "Pip", dir: "mine", noStart: false }, s.deps)).toBe(3);
    expect(s.nodeCalls.at(-1)).toEqual({
      args: ["src/cli/main.ts", "start", "--open"],
      cwd: join(s.cwd, "mine"),
      mode: "inherit",
    });
    expect(s.order.at(-1)).toBe("node start");
    expect(existsSync(join(s.cwd, "mine", ".adaegg", "logs", "install-check.log"))).toBe(false);
  });

  it("does not start when the check fails", async () => {
    const s = setup({ failOn: "check" });
    expect(await runInit({ name: "Pip", dir: "mine", noStart: false }, s.deps)).not.toBe(0);
    expect(s.nodeCalls.some((c) => c.args[1] === "start")).toBe(false);
  });

  it("starts even with skipCheck", async () => {
    const s = setup();
    expect(await runInit({ name: "Pip", dir: "mine", noStart: false, skipCheck: true }, s.deps)).toBe(0);
    expect(s.nodeCalls.at(-1)?.args[1]).toBe("start");
  });
});

describe("findTemplateDir", () => {
  it("finds the nearest ancestor with hatchling/adaegg.json", () => {
    const root = tmp();
    mkdirSync(join(root, "hatchling"));
    writeFileSync(join(root, "hatchling", "adaegg.json"), "{}");
    mkdirSync(join(root, "dist", "installer"), { recursive: true });
    expect(findTemplateDir(join(root, "dist", "installer"))).toBe(join(root, "hatchling"));
  });

  it("throws when there is none", () => {
    expect(() => findTemplateDir(tmp())).toThrow(InitError);
  });
});
