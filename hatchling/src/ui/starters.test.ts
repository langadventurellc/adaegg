import { describe, expect, it } from "vitest";
import { pickStarters, STARTER_REQUESTS } from "./starters.ts";

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("STARTER_REQUESTS", () => {
  it("has 10 to 12 unique single-line starters of 1 to 120 characters", () => {
    expect(STARTER_REQUESTS.length).toBeGreaterThanOrEqual(10);
    expect(STARTER_REQUESTS.length).toBeLessThanOrEqual(12);
    expect(new Set(STARTER_REQUESTS).size).toBe(STARTER_REQUESTS.length);
    for (const s of STARTER_REQUESTS) {
      expect(s.length).toBeGreaterThanOrEqual(1);
      expect(s.length).toBeLessThanOrEqual(120);
      expect(s).not.toMatch(/[\r\n]/);
    }
  });
});

describe("pickStarters", () => {
  it("returns 3 distinct starters from the list by default", () => {
    const picked = pickStarters(seeded(1));
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    for (const p of picked) expect(STARTER_REQUESTS).toContain(p);
  });

  it("honours count and clamps to the list length", () => {
    expect(pickStarters(seeded(2), 5)).toHaveLength(5);
    expect(pickStarters(seeded(2), 0)).toEqual([]);
    const all = pickStarters(seeded(2), 100);
    expect(all).toHaveLength(STARTER_REQUESTS.length);
    expect(new Set(all).size).toBe(STARTER_REQUESTS.length);
  });

  it("is deterministic for a seeded generator and survives random() of 1", () => {
    expect(pickStarters(seeded(7))).toEqual(pickStarters(seeded(7)));
    expect(pickStarters(() => 1)).toHaveLength(3);
  });
});
