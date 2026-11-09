import type { NameEntry } from "../names/names.ts";
import { pickSuggestions } from "../names/suggest.ts";
import type { RequestRow } from "../server/queue.ts";

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

// What the shell keeps between renders: the screen state, the request rows, the banner error, and an
// epoch that counts finished user actions. A fetch remembers the epoch it started in; if an action
// finished meanwhile, the answer may predate it and is dropped (the action's own refresh follows).
export type Session = { screen: ScreenState; rows: RequestRow[]; error: string | null; epoch: number };

export type FetchResult =
  | { kind: "state"; state: FetchedState & { queue: { requests: RequestRow[] } } }
  | { kind: "unreachable" }
  | { kind: "error"; message: string };

export function initialSession(): Session {
  return { screen: initialState(), rows: [], error: null, epoch: 0 };
}

// Call when a user action's API call has returned (success or not).
export function actionFinished(session: Session): Session {
  return { ...session, epoch: session.epoch + 1 };
}

// Fold a fetch result into the session. `keepActionError` keeps the error an action just raised
// through the refresh that follows it; a plain poll clears it on success.
export function applyFetchResult(
  session: Session,
  startedEpoch: number,
  result: FetchResult,
  random: () => number,
  keepActionError = false,
  pick: Picker = pickSuggestions,
): Session {
  if (startedEpoch !== session.epoch) return session;
  if (result.kind === "unreachable") return { ...session, screen: applyUnreachable(session.screen) };
  if (result.kind === "error") return { ...session, error: result.message };
  return {
    ...session,
    screen: applyFetched(session.screen, result.state, random, pick),
    rows: result.state.queue.requests,
    error: keepActionError ? session.error : null,
  };
}

export function setError(s: ScreenState, error: string | null): ScreenState {
  return { ...s, error };
}

export function setValue(s: ScreenState, value: string): ScreenState {
  return { ...s, value };
}
