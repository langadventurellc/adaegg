import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const license = readFileSync(join(repoRoot, "LICENSE"), "utf8");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { license?: string };

function stripFencedBlocks(md: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of md.split("\n")) {
    if (fence === undefined) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (open) fence = { char: open[0] as string, length: open.length };
      else kept.push(line);
    } else {
      // A closing fence uses the same character, at least as long as the opening one, with nothing after it.
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) fence = undefined;
    }
  }
  return kept.join("\n");
}

function extractLinks(md: string): string[] {
  const text = stripFencedBlocks(md).replace(/(`+)[^\n]*?\1(?!`)/g, "");
  const links: string[] = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1] as string;
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split("#")[0] as string;
    if (path) links.push(path);
  }
  return links;
}

function extractInlinePaths(md: string): string[] {
  const paths: string[] = [];
  for (const match of stripFencedBlocks(md).matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    const token = match[1] as string;
    if (!/^(installer|hatchling|tests|scripts|bin)\//.test(token)) continue;
    if (/[*<>{}\s]/.test(token)) continue;
    paths.push(token);
  }
  return paths;
}

describe("extraction helpers", () => {
  const md = [
    "See [a](a.md), [b](sub/b.md#frag), [web](https://example.com), [mail](mailto:x@y.z) and [top](#anchor).",
    "Inline `[no](ignored.md)` is code. Paths: `installer/a.ts`, `hatchling/<name>/x.ts`, `tests/*.ts`, `bin/hatch`, `other/x`, `bin/a b`.",
    "```",
    "[f](fenced.md) `scripts/fenced.ts`",
    "```",
    "After [c](c.md).",
  ].join("\n");

  it("strips fenced blocks", () => {
    const stripped = stripFencedBlocks(md);
    expect(stripped).not.toContain("fenced.md");
    expect(stripped).toContain("After");
  });

  it("extracts relative links only, without fragments", () => {
    expect(extractLinks(md)).toEqual(["a.md", "sub/b.md", "c.md"]);
  });

  it("extracts concrete inline paths only", () => {
    expect(extractInlinePaths(md)).toEqual(["installer/a.ts", "bin/hatch"]);
  });
});

describe("README.md", () => {
  it("has no broken relative links", () => {
    const missing = extractLinks(readme).filter((link) => !existsSync(resolve(repoRoot, dirname("README.md"), link)));
    expect(missing).toEqual([]);
  });

  it("names only paths that exist", () => {
    const missing = extractInlinePaths(readme).filter((path) => !existsSync(resolve(repoRoot, path)));
    expect(missing).toEqual([]);
  });

  it("says what it needs", () => {
    for (const text of ["ANTHROPIC_API_KEY", "Node 24", "127.0.0.1"]) {
      expect(readme).toContain(text);
    }
  });

  it("gives the one-line install, before the development section, and no npx route", () => {
    const line = "curl -fsSL https://raw.githubusercontent.com/langadventurellc/adaegg/main/install.sh | bash";
    for (const text of [
      line,
      "bash -s --",
      "node installer/main.ts init ../my-hatchling",
      "ADAEGG_SOURCE=. sh install.sh ../my-hatchling",
    ]) {
      expect(readme).toContain(text);
    }
    expect(readme).not.toContain("npx adaegg");
    expect(existsSync(join(repoRoot, "install.sh"))).toBe(true);
    expect(readme.indexOf(line)).toBeLessThan(readme.indexOf("Developing Ada Egg itself"));
  });

  it("does not present Ada Egg as another company's product", () => {
    for (const text of ["built on Claude Code", "Claude Code Agent", "made by Anthropic"]) {
      expect(readme).not.toContain(text);
    }
  });
});

describe("LICENSE", () => {
  it("is the MIT License for the Ada Egg authors", () => {
    expect(license.startsWith("MIT License")).toBe(true);
    expect(license).toContain("Copyright (c) 2026 The Ada Egg authors");
    expect(license).toContain("Permission is hereby granted, free of charge");
    expect(pkg.license).toBe("MIT");
  });
});
