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
    for (const raw of ["", "   ", "7up", "-Fu", "a<b", "a/b", "a\nb", "Name½", "Name²", "Name①"]) {
      const result = validateName(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("accepts digits after the first letter", () => {
    expect(validateName("R2D2")).toEqual({ ok: true, name: "R2D2" });
  });

  it("collapses non-breaking, thin and tab whitespace to single spaces", () => {
    expect(validateName("Fei Fei")).toEqual({ ok: true, name: "Fei Fei" });
    expect(validateName("Fei   Fei")).toEqual({ ok: true, name: "Fei Fei" });
    expect(validateName("Fei\tFei")).toEqual({ ok: true, name: "Fei Fei" });
  });

  it("accepts Ada", () => {
    expect(validateName("Ada")).toEqual({ ok: true, name: "Ada" });
  });
});
