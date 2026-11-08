import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, ConfigSchema } from "../config.ts";
import type { WorkItem } from "../store.ts";
import { type NodeContext, type RunState, RunStateSchema } from "./types.ts";

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A real git repo on `main` with one commit; `.adaegg/` is ignored.
export function buildTemplateRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "adaegg-repo-")));
  sh(dir, "init", "-b", "main");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "user.email", "test@example.com");
  writeFileSync(join(dir, "adaegg.json"), '{ "schema": 1 }\n');
  writeFileSync(join(dir, ".gitignore"), ".adaegg/\n");
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-m", "initial");
  return dir;
}

// Copies the template (including .git) to a fresh temp dir.
export function copyRepo(template: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "adaegg-copy-")));
  cpSync(template, dir, { recursive: true });
  return dir;
}

export function makeWorkItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "abcdef1234567890",
    title: "Add the thing",
    contents: "",
    kind: "item",
    status: "in_progress",
    priority: 0,
    parentId: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    ...over,
  };
}

export function makeCtx(
  root: string,
  opts: {
    config?: Partial<Config>;
    state?: Partial<RunState>;
    workItem?: Partial<WorkItem>;
    signal?: AbortSignal;
  } = {},
): NodeContext<Record<string, never>> {
  return {
    workItem: makeWorkItem(opts.workItem),
    state: RunStateSchema.parse(opts.state ?? {}),
    config: {},
    paths: { root, stateDir: join(root, ".adaegg") },
    appConfig: ConfigSchema.parse({ schema: 1, setup: "", checks: "true", ...opts.config }),
    signal: opts.signal ?? new AbortController().signal,
    now: () => new Date(),
  };
}
