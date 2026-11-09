import { describe, expect, it } from "vitest";
import { validateName } from "./validate.ts";

describe("validateName", () => {
  it("trims and collapses spaces", () => {
    expect(validateName("  Fei   Fei ")).toEqual({ ok: true, name: "Fei Fei" });
  });

  it("accepts letters from many scripts and the allowed punctuation", () => {
    for (const name of ["Arıkan", "Hau'ofa", "Kai-Fu", "Han Kang", "Anzaldúa", "Hau’ofa"]) {
      expect(validateName(name)).toEqual({ ok: true, name });
    }
  });

  it("accepts 40 characters and rejects 41", () => {
    expect(validateName("a".repeat(40)).ok).toBe(true);
    expect(validateName("a".repeat(41)).ok).toBe(false);
  });

  it("counts a letter outside the BMP as one character", () => {
    expect(validateName("𠀀".repeat(40)).ok).toBe(true);
  });

  it("rejects empty, blank, bad first characters and bad characters", () => {
    for (const raw of ["", "   ", "7up", "-Fu", "a<b", "a/b", "a\nb", "a\tb"]) {
      const result = validateName(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("accepts Ada", () => {
    expect(validateName("Ada")).toEqual({ ok: true, name: "Ada" });
  });
});
