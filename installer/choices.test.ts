import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { chooseDir, chooseName, folderFor, loadNames } from "./choices.ts";

const templateDir = join(dirname(fileURLToPath(import.meta.url)), "..", "hatchling");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "adaegg-choices-")));
  dirs.push(dir);
  return dir;
}

function prompts(answers: string[]) {
  const asked: string[] = [];
  const out: string[] = [];
  const ask = async (q: string) => {
    asked.push(q);
    return answers.shift() ?? "";
  };
  return { asked, out, ask, write: (t: string) => out.push(t) };
}

describe("folderFor", () => {
  it("makes a plain lowercase slug", () => {
    expect(folderFor("Pip Moss")).toBe("pip-moss");
    expect(folderFor("Zoë")).toBe("zoe");
    expect(folderFor("O’Neil")).toBe("o-neil");
    expect(folderFor("   ")).toBe("hatchling");
  });
});

describe("chooseName", () => {
  it("takes the suggestion on Enter", async () => {
    const names = await loadNames(templateDir);
    const suggestion = names.suggest(() => 0);
    const p = prompts([""]);
    const name = await chooseName({
      interactive: true,
      ask: p.ask,
      out: p.write,
      suggestion,
      validate: names.validate,
    });
    expect(name).toBe(suggestion);
    expect(p.asked[0]).toContain(`[${suggestion}]`);
  });

  it("asks again after an invalid answer", async () => {
    const names = await loadNames(templateDir);
    const p = prompts(["3pip", "Pip"]);
    const name = await chooseName({
      interactive: true,
      ask: p.ask,
      out: p.write,
      suggestion: "Wren",
      validate: names.validate,
    });
    expect(name).toBe("Pip");
    expect(p.asked).toHaveLength(2);
    expect(p.out.join("")).toContain("Start the name with a letter.");
  });

  it("validates and trims a given name without asking", async () => {
    const names = await loadNames(templateDir);
    const p = prompts([]);
    const base = { interactive: true, ask: p.ask, out: p.write, suggestion: "Wren", validate: names.validate };
    expect(await chooseName({ ...base, name: "  Pip   Moss " })).toBe("Pip Moss");
    await expect(chooseName({ ...base, name: "3pip" })).rejects.toThrow("Start the name with a letter.");
    expect(p.asked).toHaveLength(0);
  });

  it("returns the suggestion without asking when not interactive", async () => {
    const names = await loadNames(templateDir);
    const p = prompts([]);
    const name = await chooseName({
      interactive: false,
      ask: p.ask,
      out: p.write,
      suggestion: "Wren",
      validate: names.validate,
    });
    expect(name).toBe("Wren");
    expect(p.asked).toHaveLength(0);
  });
});

describe("chooseDir", () => {
  function base(answers: string[], interactive = true) {
    const p = prompts(answers);
    const cwd = tmp();
    const home = tmp();
    return { p, cwd, home, o: { name: "Pip Moss", cwd, home, interactive, ask: p.ask, out: p.write } };
  }

  it("takes the default on Enter", async () => {
    const { cwd, o } = base([""]);
    expect(await chooseDir(o)).toEqual({ dir: join(cwd, "pip-moss"), explicit: false });
  });

  it("expands ~ and resolves relative answers", async () => {
    const a = base(["~/x"]);
    expect((await chooseDir(a.o)).dir).toBe(join(a.home, "x"));
    const b = base(["sub/y"]);
    expect((await chooseDir(b.o)).dir).toBe(join(b.cwd, "sub", "y"));
  });

  it("asks again for a folder that is not empty", async () => {
    const { p, cwd, o } = base(["full", "fresh"]);
    mkdirSync(join(cwd, "full"));
    writeFileSync(join(cwd, "full", "f"), "");
    expect((await chooseDir(o)).dir).toBe(join(cwd, "fresh"));
    expect(p.asked).toHaveLength(2);
    expect(p.out.join("")).toContain(`${join(cwd, "full")} is not empty; pick a new or empty folder.`);
  });

  it("picks the first free folder when not interactive", async () => {
    const { cwd, o } = base([], false);
    mkdirSync(join(cwd, "pip-moss"));
    writeFileSync(join(cwd, "pip-moss", "f"), "");
    expect((await chooseDir(o)).dir).toBe(join(cwd, "pip-moss-2"));
    mkdirSync(join(cwd, "pip-moss-2"));
    writeFileSync(join(cwd, "pip-moss-2", "f"), "");
    expect((await chooseDir(o)).dir).toBe(join(cwd, "pip-moss-3"));
    rmSync(join(cwd, "pip-moss-2", "f"));
    expect((await chooseDir(o)).dir).toBe(join(cwd, "pip-moss-2"));
  });

  it("returns an explicit dir as explicit", async () => {
    const { p, cwd, o } = base([]);
    expect(await chooseDir({ ...o, dir: "here" })).toEqual({ dir: join(cwd, "here"), explicit: true });
    expect(p.asked).toHaveLength(0);
  });
});
