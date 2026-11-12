import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../engine/chat.ts";
import { NAMES, type NameEntry } from "../names/names.ts";
import type { RequestRow } from "../server/queue.ts";
import {
  actionFinished,
  anotherSuggestion,
  applyFetched,
  applyFetchResult,
  applyUnreachable,
  canSend,
  type FetchResult,
  initialSession,
  initialState,
  isSendKey,
  nameSaved,
  pollDelayMs,
  type ScreenState,
  scrollsToEnd,
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

describe("session sequencing", () => {
  const row = { id: "r1" } as unknown as RequestRow;
  const fetched = (name: string | null): FetchResult => ({
    kind: "state",
    state: { name, queue: { requests: [row] }, chat },
  });
  const chat = { messages: [{ id: 1 } as unknown as ChatMessage], busy: true };

  it("stores chat from a fresh fetch and leaves it alone on a stale epoch", () => {
    const s = applyFetchResult(initialSession(), 0, fetched("A"), () => 0);
    expect(s.chat).toEqual(chat);
    const stale = actionFinished(initialSession());
    expect(applyFetchResult(stale, 0, fetched("A"), () => 0).chat).toEqual({ messages: [], busy: false });
    expect(applyFetchResult(s, 0, { kind: "unreachable" }, () => 0).chat).toEqual(chat);
  });

  it("applies a fetch started in the current epoch", () => {
    const s = applyFetchResult(initialSession(), 0, fetched("Hopper"), () => 0);
    expect(s.screen.state?.name).toBe("Hopper");
    expect(s.rows).toEqual([row]);
  });

  it("drops a poll that started before an action finished, so it cannot undo the action", () => {
    let s = initialSession();
    const startedBefore = s.epoch;
    s = { ...s, screen: nameSaved(s.screen, "Hopper") };
    s = actionFinished(s);
    const after = applyFetchResult(s, startedBefore, fetched(null), () => 0);
    expect(after).toBe(s);
    expect(after.screen.state?.name).toBe("Hopper");
    // The refresh the action starts afterwards is applied.
    const fresh = applyFetchResult(s, s.epoch, fetched("Hopper"), () => 0);
    expect(fresh.rows).toEqual([row]);
  });

  it("drops stale failures too", () => {
    const s = actionFinished(initialSession());
    expect(applyFetchResult(s, 0, { kind: "unreachable" }, () => 0)).toBe(s);
    expect(applyFetchResult(s, 0, { kind: "error", message: "x" }, () => 0)).toBe(s);
  });

  it("keeps an action error through its refresh and clears it on a plain poll", () => {
    const s = { ...initialSession(), error: "Too long" };
    expect(applyFetchResult(s, 0, fetched("A"), () => 0, true).error).toBe("Too long");
    expect(applyFetchResult(s, 0, fetched("A"), () => 0).error).toBeNull();
  });

  it("records unreachable and errors, and a later success clears unreachable", () => {
    let s = applyFetchResult(initialSession(), 0, { kind: "unreachable" }, () => 0);
    expect(s.screen.unreachable).toBe(true);
    s = applyFetchResult(s, 0, { kind: "error", message: "boom" }, () => 0);
    expect(s.error).toBe("boom");
    s = applyFetchResult(s, 0, fetched("A"), () => 0);
    expect(s.screen.unreachable).toBe(false);
    expect(s.error).toBeNull();
  });
});

describe("chat helpers", () => {
  const m = (id: number, over: Partial<ChatMessage> = {}) =>
    ({ id, role: "assistant", text: "", status: "done", ...over }) as unknown as ChatMessage;
  const key = (k: string, over: Partial<{ shiftKey: boolean; isComposing: boolean }> = {}) => ({
    key: k,
    shiftKey: false,
    isComposing: false,
    ...over,
  });

  it("polls every second while busy and every three otherwise", () => {
    expect(pollDelayMs({ chat: { messages: [], busy: true } })).toBe(1000);
    expect(pollDelayMs({ chat: { messages: [], busy: false } })).toBe(3000);
  });

  it("canSend needs text and an idle chat", () => {
    expect(canSend("", false)).toBe(false);
    expect(canSend("  \n ", false)).toBe(false);
    expect(canSend("hi", true)).toBe(false);
    expect(canSend(" hi ", false)).toBe(true);
  });

  it("isSendKey sends on a plain Enter only", () => {
    expect(isSendKey(key("Enter"))).toBe(true);
    expect(isSendKey(key("Enter", { shiftKey: true }))).toBe(false);
    expect(isSendKey(key("Enter", { isComposing: true }))).toBe(false);
    expect(isSendKey(key("a"))).toBe(false);
  });

  it("scrollsToEnd follows new or changed messages only from the bottom", () => {
    const before = [m(1, { status: "pending" })];
    expect(scrollsToEnd(before, [...before, m(2)], true)).toBe(true);
    expect(scrollsToEnd(before, [...before, m(2)], false)).toBe(false);
    expect(scrollsToEnd(before, [m(1, { status: "done", text: "ok" })], true)).toBe(true);
    expect(scrollsToEnd(before, [m(1, { status: "pending", text: "x" })], true)).toBe(true);
    expect(scrollsToEnd(before, [m(1, { status: "done", text: "ok" })], false)).toBe(false);
    expect(scrollsToEnd(before, [m(1, { status: "pending" })], true)).toBe(false);
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
