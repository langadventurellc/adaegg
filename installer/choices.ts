import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InitError } from "./init.ts";

export type NameValidation = { ok: true; name: string } | { ok: false; error: string };

export type Ask = (question: string) => Promise<string>;

export type Names = {
  suggest(random?: () => number): string;
  validate(raw: string): NameValidation;
};

export function folderFor(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "hatchling" : slug;
}

// The specifiers are not literals so the installer build does not compile the template's files.
// This import relies on the template not being under node_modules (Node won't strip types there),
// so publishing to npm will need the names modules shipped as JS.
export async function loadNames(templateDir: string): Promise<Names> {
  const load = async (file: string): Promise<unknown> =>
    import(pathToFileURL(join(templateDir, "src/names", file)).href);
  const suggestModule = (await load("suggest.ts")) as {
    pickSuggestions(random: () => number, count?: number): { name: string }[];
  };
  const validateModule = (await load("validate.ts")) as { validateName(raw: string): NameValidation };
  return {
    suggest: (random = Math.random) => (suggestModule.pickSuggestions(random, 1)[0] as { name: string }).name,
    validate: validateModule.validateName,
  };
}

export async function chooseName(o: {
  name?: string;
  interactive: boolean;
  ask: Ask;
  out: (text: string) => void;
  suggestion: string;
  validate: (raw: string) => NameValidation;
}): Promise<string> {
  if (o.name !== undefined) {
    const result = o.validate(o.name);
    if (!result.ok) throw new InitError(result.error);
    return result.name;
  }
  if (!o.interactive) return o.suggestion;
  for (;;) {
    const answer = await o.ask(`Name your hatchling [${o.suggestion}]: `);
    const result = o.validate(answer.trim() === "" ? o.suggestion : answer);
    if (result.ok) return result.name;
    o.out(`${result.error}\n`);
  }
}

export function isFreeFolder(path: string): boolean {
  if (!existsSync(path)) return true;
  return statSync(path).isDirectory() && readdirSync(path).length === 0;
}

function expand(path: string, cwd: string, home: string): string {
  if (path === "~") return resolve(home);
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  return resolve(cwd, path);
}

export async function chooseDir(o: {
  dir?: string;
  name: string;
  cwd: string;
  home: string;
  interactive: boolean;
  ask: Ask;
  out: (text: string) => void;
}): Promise<{ dir: string; explicit: boolean }> {
  if (o.dir !== undefined) return { dir: expand(o.dir, o.cwd, o.home), explicit: true };
  const base = join(o.cwd, folderFor(o.name));
  if (!o.interactive) {
    let candidate = base;
    for (let n = 2; !isFreeFolder(candidate); n++) candidate = `${base}-${n}`;
    return { dir: candidate, explicit: false };
  }
  for (;;) {
    const answer = (await o.ask(`Where should ${o.name} live? [${base}]: `)).trim();
    const dir = answer === "" ? base : expand(answer, o.cwd, o.home);
    if (isFreeFolder(dir)) return { dir, explicit: false };
    o.out(`${dir} is not empty; pick a new or empty folder.\n`);
  }
}
