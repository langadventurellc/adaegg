import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { deletePageData, getPageData, isPageDataId, listPageData, setPageData } from "./page-data.ts";

describe("page data", () => {
  it("returns null for a missing key", () => {
    expect(getPageData(openDb(":memory:"), "water", "today")).toBeNull();
  });

  it("sets then gets a value", () => {
    const db = openDb(":memory:");
    const set = setPageData(db, "water", "today", 3);
    expect(set).toMatchObject({ key: "today", value: 3 });
    expect(getPageData(db, "water", "today")).toEqual(set);
  });

  it("overwrites the value and updates updatedAt", async () => {
    const db = openDb(":memory:");
    const first = setPageData(db, "water", "today", 1);
    await new Promise((r) => setTimeout(r, 5));
    const second = setPageData(db, "water", "today", 2);
    expect(getPageData(db, "water", "today")?.value).toBe(2);
    expect(second.updatedAt > first.updatedAt).toBe(true);
    expect(listPageData(db, "water")).toHaveLength(1);
  });

  it.each([{ a: [1, { b: "c" }] }, [1, 2], 7, null, "text", false])("round-trips %j", (value) => {
    const db = openDb(":memory:");
    setPageData(db, "p", "k", value);
    expect(getPageData(db, "p", "k")?.value).toEqual(value);
  });

  it("lists only that page's entries, ordered by key", () => {
    const db = openDb(":memory:");
    setPageData(db, "water", "b", 2);
    setPageData(db, "water", "a", 1);
    setPageData(db, "journal", "a", "x");
    expect(listPageData(db, "water").map((e) => [e.key, e.value])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(listPageData(db, "journal").map((e) => e.value)).toEqual(["x"]);
    expect(listPageData(db, "none")).toEqual([]);
  });

  it("deletes an entry, and reports a missing one", () => {
    const db = openDb(":memory:");
    setPageData(db, "water", "today", 1);
    expect(deletePageData(db, "water", "today")).toBe(true);
    expect(getPageData(db, "water", "today")).toBeNull();
    expect(deletePageData(db, "water", "today")).toBe(false);
  });

  it("checks ids", () => {
    expect(isPageDataId("water-intake_2")).toBe(true);
    expect(isPageDataId("a".repeat(64))).toBe(true);
    for (const bad of ["", "a.b", "Bad Page", "-a", "a".repeat(65)]) expect(isPageDataId(bad)).toBe(false);
  });
});
