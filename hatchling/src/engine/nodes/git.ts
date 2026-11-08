import { execFileSync, spawn, spawnSync } from "node:child_process";

export class GitError extends Error {
  stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "GitError";
    this.stderr = stderr;
  }
}

// Runs git in `cwd` and returns trimmed stdout. Throws a GitError carrying stderr.
export function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    const stdout = String((err as { stdout?: unknown }).stdout ?? "").trim();
    throw new GitError(`git ${args.join(" ")} failed: ${stderr || stdout}`, stderr || stdout);
  }
}

// The last `lines` lines of `text`, at most `maxBytes` bytes (keeping the end).
export function tail(text: string, lines = 200, maxBytes = 20000): string {
  let out = text.split("\n").slice(-lines).join("\n");
  if (Buffer.byteLength(out) > maxBytes) {
    out = Buffer.from(out).subarray(-maxBytes).toString("utf8");
  }
  return out;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function branchExists(cwd: string, branch: string): boolean {
  try {
    git(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

export function isAncestor(cwd: string, a: string, b: string): boolean {
  try {
    git(cwd, "merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
}

export function isClean(dir: string, ignore: string[] = [".adaegg/"]): boolean {
  const lines = git(dir, "status", "--porcelain")
    .split("\n")
    .filter((l) => l !== "");
  return lines.every((l) => ignore.some((i) => l.slice(3) === i || l.slice(3).startsWith(i)));
}

export function currentBranch(dir: string): string {
  return git(dir, "rev-parse", "--abbrev-ref", "HEAD");
}

// Runs a command through the shell and returns combined stdout+stderr.
export function shellSync(cwd: string, command: string): { ok: boolean; output: string } {
  const r = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`;
  return { ok: r.status === 0 && !r.error, output };
}

export type ShellResult = { ok: boolean; output: string; timedOut: boolean };

// Runs a command through the shell; kills its process group on timeout or abort.
// Rejects with the abort reason when `signal` aborts.
export function shell(
  cwd: string,
  command: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal },
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(opts.signal.reason);
      return;
    }
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let aborted = false;
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => {
      output += d;
    });
    child.stderr.on("data", (d) => {
      output += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      if (aborted) reject(opts.signal.reason);
      else resolve({ ok: code === 0 && !timedOut, output, timedOut });
    });
  });
}
