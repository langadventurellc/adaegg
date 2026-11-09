import type { NameEntry } from "../names/names.ts";
import { pickSuggestions } from "../names/suggest.ts";

export type FetchedState = { name: string | null };

export type ScreenState = {
  state: FetchedState | null;
  editingName: boolean;
  unreachable: boolean;
  suggestion: NameEntry | null;
  shown: string[];
  value: string;
  error: string | null;
  current: string | null;
};

export type Picker = typeof pickSuggestions;

export function initialState(): ScreenState {
  return {
    state: null,
    editingName: false,
    unreachable: false,
    suggestion: null,
    shown: [],
    value: "",
    error: null,
    current: null,
  };
}

function withSuggestion(s: ScreenState, entry: NameEntry, shown: string[]): ScreenState {
  return { ...s, suggestion: entry, value: entry.name, shown: [...shown, entry.name] };
}

export function applyFetched(
  s: ScreenState,
  state: FetchedState,
  random: () => number,
  pick: Picker = pickSuggestions,
): ScreenState {
  const next = { ...s, state, unreachable: false };
  if (state.name === null && next.suggestion === null) {
    const [entry] = pick(random, 1);
    if (entry !== undefined) return withSuggestion(next, entry, next.shown);
  }
  return next;
}

export function applyUnreachable(s: ScreenState): ScreenState {
  return { ...s, unreachable: true };
}

export function nameSaved(s: ScreenState, name: string): ScreenState {
  return { ...s, state: { ...s.state, name }, editingName: false, error: null, current: null };
}

export function startRename(s: ScreenState): ScreenState {
  const name = s.state?.name ?? null;
  return { ...s, editingName: true, current: name, value: name ?? "", error: null };
}

export function anotherSuggestion(s: ScreenState, random: () => number, pick: Picker = pickSuggestions): ScreenState {
  let [entry] = pick(random, 1, s.shown);
  if (entry !== undefined) return withSuggestion(s, entry, s.shown);
  // Every name has been shown this visit: start the list over, keeping only the current suggestion.
  const restart = s.suggestion === null ? [] : [s.suggestion.name];
  [entry] = pick(random, 1, restart);
  if (entry === undefined) return s;
  return withSuggestion(s, entry, restart);
}

// An error raised by a user action survives the refresh that follows it; the next poll clears it.
export function errorAfterRefresh(current: string | null, keepActionError: boolean): string | null {
  return keepActionError ? current : null;
}

export function setError(s: ScreenState, error: string | null): ScreenState {
  return { ...s, error };
}

export function setValue(s: ScreenState, value: string): ScreenState {
  return { ...s, value };
}
