import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "install.sh");
const codeload = "https://codeload.github.com/langadventurellc/adaegg/tar.gz/";

const realTools = ["mktemp", "rm", "mkdir", "tar", "gzip", "cat"];
const toolDirs = ["/usr/bin", "/bin", "/usr/local/bin"];

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adaegg-install-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let archiveDir = "";
let archive = "";
beforeAll(() => {
  archiveDir = mkdtempSync(join(tmpdir(), "adaegg-archive-"));
  archive = join(archiveDir, "adaegg-main.tar.gz");
  execFileSync("git", ["archive", "--format=tar.gz", "--prefix=adaegg-main/", "-o", archive, "HEAD"], {
    cwd: repoRoot,
  });
});

afterAll(() => {
  rmSync(archiveDir, { recursive: true, force: true });
});

interface Stubs {
  nodeVersion?: string;
  uname?: string;
  git?: boolean;
  curl?: boolean;
  nodeExit?: number;
}

function makeBin(stubs: Stubs = {}) {
  const root = tempDir();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const record = join(root, "record.txt");
  const curlRecord = join(root, "curl.txt");
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

  for (const tool of realTools) {
    const dir = toolDirs.find((d) => existsSync(join(d, tool)));
    if (dir) symlinkSync(join(dir, tool), join(bin, tool));
  }
  stub("uname", `echo ${stubs.uname ?? "Linux"}`);
  stub(
    "node",
    `if [ "$1" = "-v" ]; then echo ${stubs.nodeVersion ?? "v24.0.0"}; exit 0; fi
{
  echo "argv:$*"
  echo "cwd:$(pwd -P)"
  if [ -f "$1" ]; then echo "exists:yes"; else echo "exists:no"; fi
  echo "stdin:$(cat)"
} >> "${record}"
exit ${stubs.nodeExit ?? 0}`,
  );
  if (stubs.git !== false) stub("git", "exit 0");
  if (stubs.curl !== false) {
    stub(
      "curl",
      `echo "$*" >> "${curlRecord}"
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then cat "${archive}" > "$2"; fi
  shift
done`,
    );
  }
  return { root, bin, record, curlRecord };
}

function run(bin: string, args: string[], env: Record<string, string> = {}, cwd = tempDir(), input?: string) {
  const result = spawnSync("/bin/sh", input === undefined ? [script, ...args] : ["-s", "--", ...args], {
    cwd,
    // Never let a test reach the real /dev/tty.
    env: { PATH: bin, HOME: cwd, ADAEGG_TTY: join(cwd, "no-such-tty"), ...env },
    encoding: "utf8",
    input: input ?? "",
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, cwd };
}

function records(path: string): string[] {
  return readFileSync(path, "utf8").split("\n");
}

describe("install.sh checks", () => {
  it("rejects a Node older than 24", () => {
    const { bin } = makeBin({ nodeVersion: "v22.1.0" });
    const r = run(bin, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("v22.1.0");
    expect(r.stderr).toContain("nodejs.org");
  });

  it("rejects a missing git", () => {
    const { bin } = makeBin({ git: false });
    const r = run(bin, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("git");
  });

  it("rejects a missing curl and wget", () => {
    const { bin } = makeBin({ curl: false });
    const r = run(bin, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("curl or wget");
  });

  it("rejects Windows", () => {
    const { bin } = makeBin({ uname: "MINGW64_NT-10.0" });
    const r = run(bin, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Windows");
  });
});

describe("install.sh with ADAEGG_SOURCE", () => {
  it("runs the installer from the source, in the caller's directory, with the arguments", () => {
    const { bin, record } = makeBin();
    const source = tempDir();
    mkdirSync(join(source, "installer"));
    writeFileSync(join(source, "installer", "main.ts"), "");
    const r = run(bin, ["my-dir", "--skip-check"], { ADAEGG_SOURCE: source });
    expect(r.status).toBe(0);
    const lines = records(record);
    expect(lines).toContain(`argv:${source}/installer/main.ts init my-dir --skip-check`);
    expect(lines).toContain(`cwd:${realpathSync(r.cwd)}`);
  });

  it("passes only init when there are no arguments", () => {
    const { bin, record } = makeBin();
    const source = tempDir();
    mkdirSync(join(source, "installer"));
    writeFileSync(join(source, "installer", "main.ts"), "");
    run(bin, [], { ADAEGG_SOURCE: source });
    expect(records(record)).toContain(`argv:${source}/installer/main.ts init`);
  });

  it("gives the installer no stdin when the script is piped into the shell", () => {
    const { bin, record } = makeBin();
    const source = tempDir();
    mkdirSync(join(source, "installer"));
    writeFileSync(join(source, "installer", "main.ts"), "");
    const noTty = join(tempDir(), "missing-tty");
    const r = run(
      bin,
      ["my-dir"],
      { ADAEGG_SOURCE: source, ADAEGG_TTY: noTty },
      undefined,
      readFileSync(script, "utf8"),
    );
    expect(r.status).toBe(0);
    const lines = records(record);
    expect(lines).toContain(`argv:${source}/installer/main.ts init my-dir`);
    expect(lines).toContain("stdin:");
  });

  describe("keyboard", () => {
    function setup() {
      const made = makeBin();
      const source = tempDir();
      mkdirSync(join(source, "installer"));
      writeFileSync(join(source, "installer", "main.ts"), "");
      const ttyFile = join(tempDir(), "tty");
      writeFileSync(ttyFile, "Pip\n");
      const missing = join(tempDir(), "missing-tty");
      return { ...made, source, ttyFile, missing };
    }
    const piped = () => readFileSync(script, "utf8");

    it("gives the installer the tty when it can be opened", () => {
      const { bin, record, source, ttyFile } = setup();
      const r = run(bin, [], { ADAEGG_SOURCE: source, ADAEGG_TTY: ttyFile });
      expect(r.status).toBe(0);
      expect(records(record)).toContain("stdin:Pip");
    });

    it("gives the installer no stdin when the tty is missing", () => {
      const { bin, record, source, missing } = setup();
      const r = run(bin, [], { ADAEGG_SOURCE: source, ADAEGG_TTY: missing });
      expect(r.status).toBe(0);
      expect(records(record)).toContain("stdin:");
    });

    it("gives a piped script's installer the tty, not the script", () => {
      const { bin, record, source, ttyFile } = setup();
      const r = run(bin, [], { ADAEGG_SOURCE: source, ADAEGG_TTY: ttyFile }, undefined, piped());
      expect(r.status).toBe(0);
      const lines = records(record);
      expect(lines).toContain("stdin:Pip");
      expect(lines.join("\n")).not.toContain("set -eu");
    });

    it("gives a piped script's installer no stdin when the tty is missing", () => {
      const { bin, record, source, missing } = setup();
      const r = run(bin, [], { ADAEGG_SOURCE: source, ADAEGG_TTY: missing }, undefined, piped());
      expect(r.status).toBe(0);
      expect(records(record)).toContain("stdin:");
    });
  });

  it("fails when ADAEGG_SOURCE is not a directory", () => {
    const { bin } = makeBin();
    const r = run(bin, [], { ADAEGG_SOURCE: join(tempDir(), "missing") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ADAEGG_SOURCE");
  });
});

describe("install.sh download", () => {
  function installerPath(record: string): string {
    const argv = records(record).find((l) => l.startsWith("argv:")) as string;
    return argv.slice("argv:".length).split(" ")[0] as string;
  }

  it("downloads, extracts, runs the extracted installer and removes the temp dir", () => {
    const { bin, record, curlRecord } = makeBin();
    const r = run(bin, ["my-dir"]);
    expect(r.status).toBe(0);
    const main = installerPath(record);
    expect(main.endsWith("/installer/main.ts")).toBe(true);
    expect(records(record)).toContain("exists:yes");
    expect(records(record)).toContain(`argv:${main} init my-dir`);
    expect(readFileSync(curlRecord, "utf8")).toContain(`${codeload}main`);
    const tmp = main.slice(0, main.length - "/src/installer/main.ts".length);
    expect(existsSync(tmp)).toBe(false);
    expect(r.stdout).toContain("Downloading");
    expect(r.stdout).toContain("Creating your hatchling");
  });

  it("uses ADAEGG_REF in the URL", () => {
    const { bin, curlRecord } = makeBin();
    const r = run(bin, [], { ADAEGG_REF: "v1" });
    expect(r.status).toBe(0);
    expect(readFileSync(curlRecord, "utf8")).toContain(`${codeload}v1`);
  });

  it("returns the installer's exit code and still removes the temp dir", () => {
    const { bin, record } = makeBin({ nodeExit: 3 });
    const r = run(bin, []);
    expect(r.status).toBe(3);
    const main = installerPath(record);
    expect(existsSync(main)).toBe(false);
  });
});
