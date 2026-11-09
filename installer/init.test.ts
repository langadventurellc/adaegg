import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findTemplateDir, GITIGNORE, type InitDeps, InitError, runInit } from "./init.ts";

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

function setup(opts: { globalConfig?: string; failOn?: "install" | "check"; failLines?: number } = {}) {
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
  const deps: InitDeps = {
    cwd,
    env,
    stdout: { write: (t) => out.push(t) },
    stderr: { write: (t) => out.push(t) },
    templateDir,
    npm,
  };
  return { deps, env, cwd, calls, out, text: () => out.join("") };
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

  it("does not copy a template's node_modules, dist, .adaegg, lock or .git", async () => {
    const s = setup();
    const tpl = tmp("adaegg-tpl-");
    for (const p of ["node_modules/x", "dist/y", "src/dist/z", ".adaegg/w", ".git/HEAD"]) {
      mkdirSync(dirname(join(tpl, p)), { recursive: true });
      writeFileSync(join(tpl, p), "x");
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
    const err = await runInit({ dir: "mine", skipCheck: false }, s.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InitError);
    const message = (err as Error).message;
    expect(message).toContain("The repo was created in");
    expect(message).toContain("line 60");
    expect(message).not.toContain("line 1\n");
    expect(git(join(s.cwd, "mine"), s.env, "log", "--format=%s")).toBe("Create hatchling");
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
    for (const word of ["cd ", "npm start", "hatchling UI", "ANTHROPIC_API_KEY"]) expect(text).toContain(word);
  });

  it("quotes a path with a space in the cd line", async () => {
    const s = setup();
    await runInit({ dir: "my hatchling", skipCheck: true }, s.deps);
    expect(s.text()).toContain(`cd "${join(s.cwd, "my hatchling")}"`);
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
