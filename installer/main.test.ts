import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InitError, type InitOptions } from "./init.ts";
import { HELP, runCli } from "./main.ts";

function setup() {
  const out: string[] = [];
  const err: string[] = [];
  const calls: InitOptions[] = [];
  const io = {
    stdout: { write: (t: string) => out.push(t) },
    stderr: { write: (t: string) => err.push(t) },
    cwd: tmpdir(),
    env: {},
  };
  let code = 0;
  const fake = async (options: InitOptions) => {
    calls.push(options);
    return code;
  };
  return {
    io,
    out,
    err,
    calls,
    fake,
    exitWith: (n: number) => {
      code = n;
    },
  };
}

describe("runCli", () => {
  it("prints help", async () => {
    const s = setup();
    expect(await runCli(["--help"], s.io, { runInit: s.fake })).toBe(0);
    expect(s.out.join("")).toBe(HELP);
  });

  it.each([[[]], [["nope"]], [["init", "--nope"]], [["init", "a", "b"]]])("rejects %j", async (argv) => {
    const s = setup();
    expect(await runCli(argv, s.io, { runInit: s.fake })).toBe(1);
    expect(s.err.join("")).toContain(HELP);
    expect(s.err.join("")).toContain("adaegg: ");
    expect(s.calls).toEqual([]);
  });

  it("leaves name and folder unset by default", async () => {
    const s = setup();
    expect(await runCli(["init"], s.io, { runInit: s.fake })).toBe(0);
    expect(s.calls).toEqual([{ name: undefined, dir: undefined, skipCheck: false, noStart: false }]);
  });

  it("passes the folder and --skip-check", async () => {
    const s = setup();
    await runCli(["init", "mine", "--skip-check"], s.io, { runInit: s.fake });
    expect(s.calls).toEqual([{ name: undefined, dir: "mine", skipCheck: true, noStart: false }]);
  });

  it("passes --name, --dir and --no-start", async () => {
    const s = setup();
    await runCli(["init", "--name", "Pip Moss", "--dir", "here", "--no-start"], s.io, { runInit: s.fake });
    expect(s.calls).toEqual([{ name: "Pip Moss", dir: "here", skipCheck: false, noStart: true }]);
  });

  it("rejects a positional folder together with --dir", async () => {
    const s = setup();
    expect(await runCli(["init", "a", "--dir", "b"], s.io, { runInit: s.fake })).toBe(1);
    expect(s.err.join("")).toContain("adaegg: ");
    expect(s.calls).toEqual([]);
  });

  it("returns the exit code of init", async () => {
    const s = setup();
    s.exitWith(3);
    expect(await runCli(["init"], s.io, { runInit: s.fake })).toBe(3);
  });

  it("documents the new flags in HELP", () => {
    for (const word of ["[<dir>]", "--name <name>", "--dir <dir>", "--no-start", "--skip-check"]) {
      expect(HELP).toContain(word);
    }
  });

  it("prints an InitError as adaegg: <message>", async () => {
    const s = setup();
    const code = await runCli(["init"], s.io, {
      runInit: async () => {
        throw new InitError("boom");
      },
    });
    expect(code).toBe(1);
    expect(s.err.join("")).toBe("adaegg: boom\n");
  });

  it("prints HELP when the module is executed directly", () => {
    const out = execFileSync(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url)), "--help"], {
      encoding: "utf8",
    });
    expect(out).toBe(HELP);
  });
});
