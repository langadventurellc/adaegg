import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countCommits, PRIVATE_TERMS_ROT13, rot13, scanHistory, scanText } from "./public-scan.ts";

const anthropicKey = `${"sk-ant-"}${"a".repeat(30)}`;

const linuxHome = ["", "home", ""].join("/");
const macHome = ["", "Users", ""].join("/");
const ip = (...octets: number[]): string => octets.join(".");

const samples: [string, string][] = [
  ["private-key", `-----BEGIN ${"RSA PRIVATE KEY-----"}`],
  ["anthropic-key", anthropicKey],
  ["openai-key", `${"sk-"}${"b".repeat(40)}`],
  ["github-token", `${"ghp_"}${"a".repeat(36)}`],
  ["github-token", `${"github_pat_"}${"a".repeat(40)}`],
  ["aws-key", `${"AKIA"}${"A".repeat(16)}`],
  ["google-key", `${"AIza"}${"a".repeat(35)}`],
  ["slack-token", `${"xoxb-"}${"1".repeat(12)}`],
  ["tailscale", `${"tskey-"}${"a".repeat(14)}`],
  ["tailscale", `${"host."}${"ts.net"}`],
  ["private-host", `${"http://box."}${"internal/x"}`],
  ["private-host", `${"https://nas."}${"local"}`],
  ["private-ip", `${"192.168."}${"1.5"}`],
  ["private-ip", `${"10."}${"1.2.3"}`],
  ["home-path", `${linuxHome}alice/x`],
  ["home-path", `${macHome}bob/x`],
  ["internal-tool", `run ${"bin/"}${"ada"} now`],
  ["email", `${"me@"}${"corp.test"}`],
];

describe("scanText", () => {
  it.each(samples)("rule %s fires on a synthetic sample", (rule, sample) => {
    expect(scanText(sample, "x").map((f) => f.rule)).toContain(rule);
  });

  it("returns nothing for clean text", () => {
    expect(scanText("const a = 1;\nhello world\n", "x")).toEqual([]);
  });

  it("does not treat the adaegg entry point as the internal tool", () => {
    expect(scanText(`${"bin/"}${"adaegg.mjs"}`, "x")).toEqual([]);
  });

  it("allows example addresses and refuses others", () => {
    expect(scanText("me@example.com", "x")).toEqual([]);
    expect(scanText(`${"me@"}${"corp.test"}`, "x").map((f) => f.rule)).toEqual(["email"]);
  });

  it("skips named rules", () => {
    expect(scanText(`${"192.168."}${"1.5"}`, "x", { skipRules: ["private-ip"] })).toEqual([]);
  });

  it("respects private-ip range boundaries", () => {
    for (const outside of [ip(172, 15, 0, 1), ip(172, 32, 0, 1), ip(100, 128, 0, 1), ip(100, 63, 0, 1), "1.10.2.3.4"]) {
      expect(scanText(outside, "x")).toEqual([]);
    }
    for (const inside of [ip(172, 16, 0, 1), ip(172, 31, 0, 1), ip(100, 64, 0, 1), ip(100, 127, 0, 1)]) {
      expect(scanText(inside, "x").map((f) => f.rule)).toEqual(["private-ip"]);
    }
  });

  it("allows placeholder home paths", () => {
    for (const name of ["you", "user", "username", "name"]) {
      expect(scanText(`${linuxHome}${name}/x`, "x")).toEqual([]);
    }
  });

  it("reports 1-based lines and the source", () => {
    const [finding] = scanText(`ok\n${anthropicKey}`, "f.txt");
    expect(finding).toMatchObject({ source: "f.txt", line: 2, rule: "anthropic-key" });
  });

  it("truncates the sample", () => {
    const [finding] = scanText(anthropicKey, "x");
    expect(finding?.sample).toBe("sk-a...");
    expect(JSON.stringify(finding)).not.toContain(anthropicKey);
  });

  describe.each(PRIVATE_TERMS_ROT13.map((enc, i) => [i, enc] as const))("private term %i", (_i, enc) => {
    const term = rot13(enc);
    it("fires, case-insensitively", () => {
      expect(scanText(`see ${term} here`, "x").map((f) => f.rule)).toEqual(["private-term"]);
      expect(scanText(term.toUpperCase(), "x").map((f) => f.rule)).toEqual(["private-term"]);
    });
    it("does not fire inside a longer word", () => {
      expect(scanText(`x${term}y`, "x")).toEqual([]);
    });
  });
});

describe("scanHistory", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  function repo(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "adaegg-scan-")));
    dirs.push(dir);
    git(dir, "init", "-b", "main");
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.com");
    return dir;
  }

  function commit(dir: string, message: string): void {
    git(dir, "add", "-A");
    git(dir, "-c", "commit.gpgsign=false", "commit", "-m", message);
  }

  it("finds a secret that a later commit deleted", () => {
    const dir = repo();
    writeFileSync(join(dir, "secret.txt"), `${anthropicKey}\n`);
    commit(dir, "add");
    git(dir, "rm", "secret.txt");
    commit(dir, "remove");
    const first = git(dir, "rev-parse", "HEAD~1").slice(0, 8);
    const found = scanHistory(dir).filter((f) => f.rule === "anthropic-key");
    expect(found.length).toBeGreaterThan(0);
    const added = found.find((f) => f.source.startsWith(first));
    expect(added?.source).toContain("secret.txt");
    expect(countCommits(dir)).toBe(2);
  });

  it("is clean for a clean repo and for an empty one", () => {
    const dir = repo();
    expect(scanHistory(dir)).toEqual([]);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    commit(dir, "add a");
    expect(scanHistory(dir)).toEqual([]);
    expect(countCommits(dir)).toBe(1);
  });
});
