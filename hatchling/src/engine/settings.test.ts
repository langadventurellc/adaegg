import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { getSetting, setSetting } from "./settings.ts";

describe("settings", () => {
  it("returns null for a missing key", () => {
    expect(getSetting(openDb(":memory:"), "name")).toBeNull();
  });

  it("stores and reads a value", () => {
    const db = openDb(":memory:");
    setSetting(db, "name", "Pip");
    expect(getSetting(db, "name")).toBe("Pip");
  });

  it("overwrites on a second set", () => {
    const db = openDb(":memory:");
    setSetting(db, "name", "Pip");
    setSetting(db, "name", "Moss");
    expect(getSetting(db, "name")).toBe("Moss");
  });
});
