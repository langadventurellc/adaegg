import { describe, expect, it } from "vitest";
import { FIELDS, GENDERS, NAMES, type NameEntry, REGIONS } from "./names.ts";
import { validateName } from "./validate.ts";

const normalise = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const COMMON_NAMES = [
  "John",
  "Mary",
  "David",
  "Michael",
  "Anna",
  "Alan",
  "Grace",
  "Maria",
  "Daniel",
  "Sarah",
  "James",
  "Robert",
].map(normalise);

const MIN_ENTRIES = 80;
const MAX_KNOWN_FOR = 90;

// biome-ignore lint/suspicious/noExportsInTest: the rule helpers are exported for test, as the work item requires
export function sizeAndUniqueness(list: readonly NameEntry[]): string[] {
  const errors: string[] = [];
  if (list.length < MIN_ENTRIES) {
    errors.push(`list has ${list.length} entries, need at least ${MIN_ENTRIES}`);
  }
  const seen = new Set<string>();
  for (const e of list) {
    const key = normalise(e.name);
    if (seen.has(key)) errors.push(`${e.name}: name is not unique`);
    seen.add(key);
  }
  return errors;
}

// biome-ignore lint/suspicious/noExportsInTest: the rule helpers are exported for test, as the work item requires
export function noAda(list: readonly NameEntry[]): string[] {
  const errors: string[] = [];
  for (const e of list) {
    if (normalise(e.name) === "ada") errors.push(`${e.name}: name is Ada`);
    if (/^ada\b/i.test(e.person)) errors.push(`${e.name}: person ${e.person} begins with Ada`);
  }
  return errors;
}

// biome-ignore lint/suspicious/noExportsInTest: the rule helpers are exported for test, as the work item requires
export function completeEntries(list: readonly NameEntry[]): string[] {
  const errors: string[] = [];
  for (const e of list) {
    if (e.person.trim() === "") errors.push(`${e.name}: person is empty`);
    if (e.knownFor.length < 1 || e.knownFor.length > MAX_KNOWN_FOR) {
      errors.push(`${e.name}: knownFor has ${e.knownFor.length} characters, need 1 to ${MAX_KNOWN_FOR}`);
    }
    if (!(REGIONS as readonly string[]).includes(e.region)) errors.push(`${e.name}: region ${e.region} is not allowed`);
    if (!(GENDERS as readonly string[]).includes(e.gender)) errors.push(`${e.name}: gender ${e.gender} is not allowed`);
    if (!(FIELDS as readonly string[]).includes(e.field)) errors.push(`${e.name}: field ${e.field} is not allowed`);
  }
  return errors;
}

// biome-ignore lint/suspicious/noExportsInTest: the rule helpers are exported for test, as the work item requires
export function genderBalance(list: readonly NameEntry[]): string[] {
  const errors: string[] = [];
  for (const g of GENDERS) {
    const share = list.filter((e) => e.gender === g).length / list.length;
    if (!(share >= 0.4 && share <= 0.6)) {
      errors.push(`${g}: ${Math.round(share * 100)}% of the list, need 40% to 60%`);
    }
  }
  return errors;
}

// biome-ignore lint/suspicious/noExportsInTest: the rule helpers are exported for test, as the work item requires
export function regionBalance(list: readonly NameEntry[]): string[] {
  const errors: string[] = [];
  let present = 0;
  for (const r of REGIONS) {
    const count = list.filter((e) => e.region === r).length;
    const share = count / list.length;
    if (share > 0.2) errors.push(`${r}: ${Math.round(share * 100)}% of the list, need at most 20%`);
    if (r === "western-europe" && share > 0.15) {
      errors.push(`${r}: ${Math.round(share * 100)}% of the list, need at most 15%`);
    }
    if (count >= 2) present++;
  }
  if (present < 9) errors.push(`only ${present} regions have at least 2 entries, need 9`);
  return errors;
}

// biome-ignore lint/suspicious/noExportsInTest: the rule helpers are exported for test, as the work item requires
export function fieldBalance(list: readonly NameEntry[]): string[] {
  const errors: string[] = [];
  for (const f of FIELDS) {
    const count = list.filter((e) => e.field === f).length;
    if (count < 6) errors.push(`${f}: ${count} entries, need at least 6`);
  }
  return errors;
}

// biome-ignore lint/suspicious/noExportsInTest: the rule helpers are exported for test, as the work item requires
export function distinctive(list: readonly NameEntry[]): string[] {
  return list.filter((e) => COMMON_NAMES.includes(normalise(e.name))).map((e) => `${e.name}: name is too common`);
}

// biome-ignore lint/suspicious/noExportsInTest: the rule helpers are exported for test, as the work item requires
export function validNames(list: readonly NameEntry[]): string[] {
  const errors: string[] = [];
  for (const e of list) {
    const result = validateName(e.name);
    if (!result.ok) errors.push(`${e.name}: ${result.error}`);
    else if (result.name !== e.name) errors.push(`${e.name}: validateName changes it to ${result.name}`);
  }
  return errors;
}

describe("NAMES", () => {
  it("has enough entries with unique names", () => {
    expect(sizeAndUniqueness(NAMES)).toEqual([]);
  });

  it("never contains Ada", () => {
    expect(noAda(NAMES)).toEqual([]);
  });

  it("has complete entries with allowed values", () => {
    expect(completeEntries(NAMES)).toEqual([]);
  });

  it("is balanced across genders", () => {
    expect(genderBalance(NAMES)).toEqual([]);
  });

  it("is balanced across regions", () => {
    expect(regionBalance(NAMES)).toEqual([]);
  });

  it("covers every field", () => {
    expect(fieldBalance(NAMES)).toEqual([]);
  });

  it("has distinctive names", () => {
    expect(distinctive(NAMES)).toEqual([]);
  });

  it("has names that pass validateName unchanged", () => {
    expect(validNames(NAMES)).toEqual([]);
  });
});

describe("the rules catch a bad list", () => {
  const base = NAMES[0] as NameEntry;
  const entry = (i: number, over: Partial<NameEntry> = {}): NameEntry => ({
    ...base,
    name: `Name${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`,
    ...over,
  });
  const make = (n: number, over: (i: number) => Partial<NameEntry> = () => ({})) =>
    Array.from({ length: n }, (_, i) => entry(i, over(i)));
  // Varied enough to pass every rule except the one under test.
  const varied = (i: number): Partial<NameEntry> => ({
    region: REGIONS[i % REGIONS.length] as NameEntry["region"],
    gender: GENDERS[i % GENDERS.length] as NameEntry["gender"],
    field: FIELDS[i % FIELDS.length] as NameEntry["field"],
  });

  it("accepts a good fabricated list", () => {
    const good = make(100, varied);
    for (const rule of [
      sizeAndUniqueness,
      noAda,
      completeEntries,
      genderBalance,
      regionBalance,
      fieldBalance,
      distinctive,
      validNames,
    ]) {
      expect(rule(good)).toEqual([]);
    }
  });

  it("flags a list of one region", () => {
    expect(regionBalance(make(100, (i) => ({ ...varied(i), region: "western-europe" }))).length).toBeGreaterThan(0);
  });

  it("flags a list of one gender", () => {
    expect(genderBalance(make(100, (i) => ({ ...varied(i), gender: "woman" }))).length).toBeGreaterThan(0);
  });

  it("flags Ada as a name and as a person", () => {
    expect(noAda([...make(99, varied), entry(99, { name: "Ada" })]).length).toBeGreaterThan(0);
    expect(noAda([...make(99, varied), entry(99, { person: "Ada Lovelace" })]).length).toBeGreaterThan(0);
  });

  it("flags a duplicate name", () => {
    expect(sizeAndUniqueness([...make(99, varied), entry(99, { name: "Námeaa" })]).length).toBeGreaterThan(0);
  });

  it("flags a knownFor that is too long or empty", () => {
    expect(completeEntries([entry(0, { knownFor: "x".repeat(91) })]).length).toBeGreaterThan(0);
    expect(completeEntries([entry(0, { knownFor: "" })]).length).toBeGreaterThan(0);
  });

  it("flags a common name", () => {
    expect(distinctive([entry(0, { name: "Álan" })]).length).toBeGreaterThan(0);
  });

  it("flags a field with fewer than 6 entries", () => {
    expect(fieldBalance(make(100, (i) => ({ ...varied(i), field: i < 98 ? "ai" : "poetry" }))).length).toBeGreaterThan(
      0,
    );
  });

  it("flags a name that fails validateName", () => {
    expect(validNames([entry(0, { name: "9Lives" })]).length).toBeGreaterThan(0);
    expect(validNames([entry(0, { name: "Two  Spaces" })]).length).toBeGreaterThan(0);
  });

  it("flags a list with fewer than 80 entries", () => {
    expect(sizeAndUniqueness(make(79, varied)).length).toBeGreaterThan(0);
  });
});
