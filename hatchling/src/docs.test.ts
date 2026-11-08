import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { COMMANDS, HELP } from "./cli/main.ts";

const hatchlingRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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
    if (!/^(src|docs|workflows|prompts|bin)\//.test(token)) continue;
    if (/[*<>{}\s]/.test(token)) continue;
    paths.push(token);
  }
  return paths;
}

function cliBlock(agentsMd: string): string {
  const lines = agentsMd.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## The `hatch` CLI");
  if (start < 0) return "";
  const block: string[] = [];
  let inside = false;
  for (const line of lines.slice(start + 1)) {
    if (!inside && /^## /.test(line)) break;
    if (/^\s*```/.test(line)) {
      if (inside) break;
      inside = true;
    } else if (inside) block.push(line);
  }
  return block.join("\n");
}

function cliBlockCommands(agentsMd: string): string[] {
  const commands: string[] = [];
  for (const line of cliBlock(agentsMd).split("\n")) {
    const name = /^hatch (\S+)/.exec(line)?.[1];
    if (name) commands.push(name);
  }
  return commands;
}

function docsFiles(root: string): string[] {
  return ["AGENTS.md", ...allDocsFiles(root).filter((f) => f.endsWith(".md"))];
}

// Every file under docs/, whatever its type.
function allDocsFiles(root: string): string[] {
  if (!existsSync(join(root, "docs"))) return [];
  return (readdirSync(join(root, "docs"), { recursive: true }) as string[])
    .map((f) => join("docs", f))
    .filter((f) => statSync(join(root, f)).isFile())
    .sort();
}

function checkLinks(root: string, files: string[]): string[] {
  const errors: string[] = [];
  for (const file of files) {
    for (const link of extractLinks(readFileSync(join(root, file), "utf8"))) {
      if (!existsSync(resolve(root, dirname(file), link))) errors.push(`${file}: broken link ${link}`);
    }
  }
  return errors;
}

function checkInlinePaths(root: string, files: string[]): string[] {
  const errors: string[] = [];
  for (const file of files) {
    for (const path of extractInlinePaths(readFileSync(join(root, file), "utf8"))) {
      if (!existsSync(resolve(root, path))) errors.push(`${file}: missing path ${path}`);
    }
  }
  return errors;
}

function checkReachability(root: string): string[] {
  const seen = new Set<string>(["AGENTS.md"]);
  const queue = ["AGENTS.md"];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (!existsSync(join(root, file))) continue;
    for (const link of extractLinks(readFileSync(join(root, file), "utf8"))) {
      const target = resolve(root, dirname(file), link).slice(resolve(root).length + 1);
      if (seen.has(target)) continue;
      seen.add(target);
      if (target.endsWith(".md")) queue.push(target);
    }
  }
  return allDocsFiles(root)
    .filter((f) => !seen.has(f))
    .map((f) => `${f}: not reachable from AGENTS.md by links`);
}

function listFiles(dir: string, ext: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)) : [];
}

function checkWorkflowCoverage(root: string): string[] {
  const named = ["docs/system/workflows.md", "docs/system/agents.md"]
    .filter((f) => existsSync(join(root, f)))
    .flatMap((f) => extractInlinePaths(readFileSync(join(root, f), "utf8")));
  const files = [
    ...listFiles(join(root, "workflows"), ".yaml").map((f) => `workflows/${f}`),
    ...listFiles(join(root, "prompts"), ".md").map((f) => `prompts/${f}`),
  ];
  return files
    .filter((f) => !named.includes(f))
    .map((f) => `${f}: not named in docs/system/workflows.md or docs/system/agents.md`);
}

function checkCliCommands(agentsMd: string, commands: string[]): string[] {
  const listed = cliBlockCommands(agentsMd);
  return [
    ...commands.filter((c) => !listed.includes(c)).map((c) => `AGENTS.md: CLI block is missing command ${c}`),
    ...listed.filter((c) => !commands.includes(c)).map((c) => `AGENTS.md: CLI block lists unknown command ${c}`),
  ];
}

describe("extraction helpers", () => {
  const md = [
    "See [a](a.md), [b](sub/b.md#frag), [web](https://example.com), [mail](mailto:x@y.z) and [top](#anchor).",
    "Inline `[no](ignored.md)` is code. Paths: `src/a.ts`, `src/<name>/x.ts`, `docs/*.md`, `bin/hatch`, `other/x`, `docs/a b`.",
    "```",
    "[f](fenced.md) `src/fenced.ts`",
    "```",
    "~~~",
    "[t](tilde.md) `docs/tilde.md`",
    "~~~",
    "After [c](c.md).",
  ].join("\n");

  it("strips fenced blocks", () => {
    const stripped = stripFencedBlocks(md);
    expect(stripped).not.toContain("fenced.md");
    expect(stripped).not.toContain("tilde.md");
    expect(stripped).toContain("After");
  });

  it("extracts relative links only, without fragments", () => {
    expect(extractLinks(md)).toEqual(["a.md", "sub/b.md", "c.md"]);
  });

  it("extracts concrete inline paths only", () => {
    expect(extractInlinePaths(md)).toEqual(["src/a.ts", "bin/hatch"]);
  });

  it("keeps a longer fence open until a closing fence at least as long", () => {
    const text = ["````", "```", "[in](inside.md) `src/inside.ts`", "```", "````", "[out](outside.md)"].join("\n");
    expect(extractLinks(text)).toEqual(["outside.md"]);
    expect(extractInlinePaths(text)).toEqual([]);
  });

  it("ignores double-backtick spans as inline paths and links", () => {
    const text = "Only ``src/missing.ts`` and ``[x](double.md)`` here, but `src/real.ts` counts.";
    expect(extractInlinePaths(text)).toEqual(["src/real.ts"]);
    expect(extractLinks(text)).toEqual([]);
  });

  it("reads the commands of the CLI block", () => {
    const agents =
      '## The `hatch` CLI\n\n```\nhatch add "x"\nhatch list  # c\n  hatch no\n```\n\n## Next\n\n```\nhatch other\n```\n';
    expect(cliBlockCommands(agents)).toEqual(["add", "list"]);
  });
});

describe("failing cases", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "docs-test-"));
    dirs.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  it("reports a broken link", () => {
    const root = fixture({ "AGENTS.md": "[x](docs/gone.md)" });
    expect(checkLinks(root, ["AGENTS.md"])).toEqual(["AGENTS.md: broken link docs/gone.md"]);
  });

  it("resolves links against the file's directory", () => {
    const root = fixture({ "AGENTS.md": "x", "docs/a.md": "[b](b.md)", "docs/b.md": "x" });
    expect(checkLinks(root, ["AGENTS.md", "docs/a.md"])).toEqual([]);
  });

  it("reports a missing inline path", () => {
    const root = fixture({ "docs/a.md": "see `src/missing.ts`" });
    expect(checkInlinePaths(root, ["docs/a.md"])).toEqual(["docs/a.md: missing path src/missing.ts"]);
  });

  it("reports an orphan doc", () => {
    const root = fixture({ "AGENTS.md": "[a](docs/a.md)", "docs/a.md": "x", "docs/orphan.md": "x" });
    const errors = checkReachability(root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("docs/orphan.md");
  });

  it("reports an unlinked non-Markdown doc file and accepts a linked one", () => {
    const root = fixture({
      "AGENTS.md": "[a](docs/a.md)",
      "docs/a.md": "[img](diagram.svg)",
      "docs/diagram.svg": "<svg/>",
      "docs/stray.json": "{}",
    });
    expect(checkReachability(root)).toEqual(["docs/stray.json: not reachable from AGENTS.md by links"]);
  });

  it("follows links through other docs", () => {
    const root = fixture({ "AGENTS.md": "[a](docs/a.md)", "docs/a.md": "[b](sub/b.md)", "docs/sub/b.md": "x" });
    expect(checkReachability(root)).toEqual([]);
  });

  it("reports an undocumented workflow and prompt file", () => {
    const root = fixture({
      "workflows/known.yaml": "",
      "workflows/lost.yaml": "",
      "prompts/lost.md": "",
      "docs/system/workflows.md": "`workflows/known.yaml`",
      "docs/system/agents.md": "x",
    });
    const errors = checkWorkflowCoverage(root);
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toContain("workflows/lost.yaml");
    expect(errors.join("\n")).toContain("prompts/lost.md");
  });

  it("reports a command missing from the CLI block and one the CLI lacks", () => {
    const agents = "## The `hatch` CLI\n\n```\nhatch add\nhatch bogus\n```\n";
    const errors = checkCliCommands(agents, ["add", "list"]);
    expect(errors).toEqual([
      "AGENTS.md: CLI block is missing command list",
      "AGENTS.md: CLI block lists unknown command bogus",
    ]);
  });
});

describe("the real docs", () => {
  const files = docsFiles(hatchlingRoot);

  it("have no broken relative links", () => {
    expect(checkLinks(hatchlingRoot, files)).toEqual([]);
  });

  it("name only paths that exist", () => {
    expect(checkInlinePaths(hatchlingRoot, files)).toEqual([]);
  });

  it("link every doc from AGENTS.md", () => {
    expect(checkReachability(hatchlingRoot)).toEqual([]);
  });

  it("name every workflow and prompt file", () => {
    expect(checkWorkflowCoverage(hatchlingRoot)).toEqual([]);
  });

  it("list the CLI commands in AGENTS.md", () => {
    const agents = readFileSync(join(hatchlingRoot, "AGENTS.md"), "utf8");
    expect(checkCliCommands(agents, COMMANDS)).toEqual([]);
  });

  it("keep HELP and COMMANDS in step", () => {
    for (const command of COMMANDS) expect(HELP).toContain(`  ${command}`);
  });
});
