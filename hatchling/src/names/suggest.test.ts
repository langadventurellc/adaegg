import { describe, expect, it } from "vitest";
import { NAMES, REGIONS } from "./names.ts";
import { pickSuggestions } from "./suggest.ts";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normalise = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

describe("pickSuggestions", () => {
  it("never offers Ada, never repeats a region, covers every region and is not western-Europe heavy", () => {
    const random = mulberry32(1);
    const seen = new Set<string>();
    let westernFirst = 0;
    const batches = 2000;
    for (let i = 0; i < batches; i++) {
      const batch = pickSuggestions(random, 3);
      expect(batch).toHaveLength(3);
      const regions = batch.map((e) => e.region);
      expect(new Set(regions).size).toBe(regions.length);
      for (const e of batch) {
        expect(normalise(e.name)).not.toBe("ada");
        seen.add(e.region);
      }
      if (batch[0]?.region === "western-europe") westernFirst++;
    }
    for (const region of REGIONS) {
      if (NAMES.some((e) => e.region === region)) expect(seen.has(region)).toBe(true);
    }
    expect(westernFirst / batches).toBeLessThanOrEqual(0.15);
  });

  it("honours exclude case-insensitively", () => {
    const random = mulberry32(2);
    for (let i = 0; i < 500; i++) {
      const names = pickSuggestions(random, 10, ["hopper", "TURING"]).map((e) => e.name);
      expect(names).not.toContain("Hopper");
      expect(names).not.toContain("Turing");
    }
  });

  it("returns [] when every name is excluded", () => {
    expect(
      pickSuggestions(
        mulberry32(3),
        3,
        NAMES.map((e) => e.name),
      ),
    ).toEqual([]);
  });

  it("returns [] when count is 0 or less", () => {
    expect(pickSuggestions(mulberry32(3), 0)).toEqual([]);
    expect(pickSuggestions(mulberry32(3), -2)).toEqual([]);
  });

  it("returns one entry per region when count exceeds the regions", () => {
    const present = new Set(NAMES.map((e) => e.region));
    const batch = pickSuggestions(mulberry32(4), 100);
    expect(batch).toHaveLength(present.size);
    expect(new Set(batch.map((e) => e.region)).size).toBe(present.size);
  });

  it("is deterministic per seed", () => {
    const a = pickSuggestions(mulberry32(5), 3);
    expect(pickSuggestions(mulberry32(5), 3)).toEqual(a);
    expect(pickSuggestions(mulberry32(6), 3)).not.toEqual(a);
  });

  it("does not mutate exclude", () => {
    const exclude = ["Hopper"];
    pickSuggestions(mulberry32(7), 3, exclude);
    expect(exclude).toEqual(["Hopper"]);
  });

  it("copes with constant random values", () => {
    for (const value of [0, 0.9999999999]) {
      const batch = pickSuggestions(() => value, 3);
      expect(batch).toHaveLength(3);
      for (const e of batch) expect(NAMES).toContain(e);
    }
  });
});
