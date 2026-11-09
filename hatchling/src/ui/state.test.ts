import { describe, expect, it } from "vitest";
import { NAMES, type NameEntry } from "../names/names.ts";
import {
  anotherSuggestion,
  applyFetched,
  applyUnreachable,
  errorAfterRefresh,
  initialState,
  nameSaved,
  type ScreenState,
  setError,
  setValue,
  startRename,
} from "./state.ts";
import { screenFor } from "./view.ts";

function counter(): () => number {
  let i = 0;
  return () => {
    i = (i + 0.137) % 1;
    return i;
  };
}

describe("state transitions", () => {
  it("starts empty", () => {
    const s = initialState();
    expect(s.state).toBeNull();
    expect(s.unreachable).toBe(false);
    expect(screenFor(s.state, s.editingName, s.unreachable)).toBe("onboarding");
  });

  it("picks a first suggestion once when there is no name", () => {
    const s = applyFetched(initialState(), { name: null }, counter());
    expect(s.suggestion).not.toBeNull();
    expect(s.value).toBe(s.suggestion?.name);
    expect(s.shown).toEqual([s.suggestion?.name]);
    const again = applyFetched(s, { name: null }, () => 0.99);
    expect(again.suggestion).toBe(s.suggestion);
  });

  it("does not pick a suggestion when the hatchling is named", () => {
    const s = applyFetched(initialState(), { name: "Hopper" }, counter());
    expect(s.suggestion).toBeNull();
    expect(screenFor(s.state, s.editingName, s.unreachable)).toBe("ask");
  });

  it("sets unreachable and clears it on a fetch", () => {
    const down = applyUnreachable(applyFetched(initialState(), { name: "Hopper" }, counter()));
    expect(down.unreachable).toBe(true);
    expect(screenFor(down.state, false, down.unreachable)).toBe("unreachable");
    const up = applyFetched(down, { name: "Hopper" }, counter());
    expect(up.unreachable).toBe(false);
  });

  it("nameSaved leads to ask", () => {
    let s = applyFetched(initialState(), { name: null }, counter());
    s = setError(s, "bad");
    s = nameSaved(s, "Hopper");
    expect(s.state?.name).toBe("Hopper");
    expect(s.error).toBeNull();
    expect(s.current).toBeNull();
    expect(s.editingName).toBe(false);
    expect(screenFor(s.state, s.editingName, s.unreachable)).toBe("ask");
  });

  it("startRename prefills the current name", () => {
    let s = applyFetched(initialState(), { name: "Hopper" }, counter());
    s = startRename(setError(s, "old"));
    expect(s.editingName).toBe(true);
    expect(s.current).toBe("Hopper");
    expect(s.value).toBe("Hopper");
    expect(s.error).toBeNull();
    expect(screenFor(s.state, s.editingName, s.unreachable)).toBe("onboarding");
  });

  it("setValue and setError are small updates", () => {
    const s = initialState();
    expect(setValue(s, "x").value).toBe("x");
    expect(setError(s, "e").error).toBe("e");
  });
});

describe("errorAfterRefresh", () => {
  it("keeps an action error through the refresh that follows it, and clears it on a plain poll", () => {
    expect(errorAfterRefresh("Too long", true)).toBe("Too long");
    expect(errorAfterRefresh("Too long", false)).toBeNull();
    expect(errorAfterRefresh(null, true)).toBeNull();
  });
});

describe("anotherSuggestion", () => {
  it("never repeats a name within a visit until exhausted", () => {
    const random = counter();
    let s: ScreenState = applyFetched(initialState(), { name: null }, random);
    const seen = new Set([s.suggestion?.name]);
    for (let i = 1; i < NAMES.length; i++) {
      s = anotherSuggestion(s, random);
      expect(seen.has(s.suggestion?.name)).toBe(false);
      seen.add(s.suggestion?.name);
      expect(s.value).toBe(s.suggestion?.name);
    }
    expect(s.shown.length).toBe(NAMES.length);
  });

  it("starts the list over when exhausted, without repeating the current one at once", () => {
    const random = counter();
    let s: ScreenState = applyFetched(initialState(), { name: null }, random);
    for (let i = 1; i < NAMES.length; i++) s = anotherSuggestion(s, random);
    const last = s.suggestion?.name;
    const next = anotherSuggestion(s, random);
    expect(next.suggestion?.name).not.toBe(last);
    expect(next.shown).toEqual([last, next.suggestion?.name]);
  });

  it("uses an injected picker and restarts on an empty result", () => {
    const a = { name: "A", person: "P", knownFor: "k" } as NameEntry;
    const b = { name: "B", person: "P", knownFor: "k" } as NameEntry;
    const calls: (readonly string[])[] = [];
    const pick = (_r: () => number, _c?: number, exclude: readonly string[] = []) => {
      calls.push(exclude);
      return exclude.includes("A") && exclude.length > 1 ? [] : [exclude.includes("A") ? b : a];
    };
    let s = applyFetched(initialState(), { name: null }, () => 0, pick);
    expect(s.suggestion).toBe(a);
    s = anotherSuggestion(s, () => 0, pick);
    expect(s.suggestion).toBe(b);
    expect(s.shown).toEqual(["A", "B"]);
    s = anotherSuggestion(s, () => 0, pick);
    expect(calls.at(-2)).toEqual(["A", "B"]);
    expect(calls.at(-1)).toEqual(["B"]);
    expect(s.shown).toEqual(["B", "A"]);
  });
});
