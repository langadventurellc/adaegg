import { describe, expect, it } from "vitest";
import { isPageId, PAGE_ID, PAGES, type Page } from "./index.ts";

// Typechecked: a renderer may return nothing or a cleanup function.
function drawPlain(_root: HTMLElement): void {}
function drawWithCleanup(_root: HTMLElement): () => void {
  return () => {};
}
const FIXTURES: Page[] = [
  { id: "plain", title: "Plain", render: drawPlain },
  { id: "with-cleanup", title: "With cleanup", render: drawWithCleanup },
];

describe("Page.render", () => {
  it("accepts renderers with and without a cleanup function", () => {
    expect(FIXTURES.map((page) => page.id)).toEqual(["plain", "with-cleanup"]);
  });
});

describe("PAGES", () => {
  it("has unique, kebab-case ids and non-empty titles", () => {
    const ids = PAGES.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const page of PAGES) {
      expect(page.id).not.toBe("");
      expect(page.id).toMatch(PAGE_ID);
      expect(typeof page.title).toBe("string");
      expect(page.title.trim()).not.toBe("");
      expect(typeof page.render).toBe("function");
    }
  });
});

describe("isPageId", () => {
  it("accepts lowercase kebab-case", () => {
    for (const id of ["tip", "tip-calculator", "a1-b2-c3", "42"]) expect(isPageId(id)).toBe(true);
  });

  it("rejects everything else", () => {
    for (const id of ["", "Tip", "tip_calc", "-tip", "tip-", "tip--calc", "tip calc", "a/b", "<script>", "é"]) {
      expect(isPageId(id)).toBe(false);
    }
  });
});
