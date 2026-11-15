import type { ChatMessage } from "../engine/chat.ts";
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
export type ChatState = { messages: ChatMessage[]; busy: boolean };

export type Session = {
  screen: ScreenState;
  rows: RequestRow[];
  chat: ChatState;
  error: string | null;
  epoch: number;
};

export type FetchResult =
  | { kind: "state"; state: FetchedState & { queue: { requests: RequestRow[] }; chat: ChatState } }
  | { kind: "unreachable" }
  | { kind: "error"; message: string };

export function initialSession(): Session {
  return { screen: initialState(), rows: [], chat: { messages: [], busy: false }, error: null, epoch: 0 };
}

export function pollDelayMs(session: Pick<Session, "chat">): number {
  return session.chat.busy ? 1000 : 3000;
}

export function canSend(text: string, busy: boolean): boolean {
  return !busy && text.trim() !== "";
}

// A new conversation needs something to leave behind and no reply pending.
export function canStartNewConversation(messages: readonly ChatMessage[], busy: boolean): boolean {
  return messages.length > 0 && !busy;
}

// What the screen shows once the server has accepted a new conversation, before the refresh
// confirms it: an empty idle thread. A rejected request (409, unreachable) changes nothing,
// whatever the refresh that follows says.
export function chatAfterNewConversation<T extends { messages: readonly unknown[]; busy: boolean }>(
  chat: T,
  posted: boolean,
): T {
  return posted ? { ...chat, messages: [], busy: false } : chat;
}

export function isSendKey(e: { key: string; shiftKey: boolean; isComposing: boolean }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing;
}

// True when the reader is at the bottom and a message arrived or a known one changed (a pending reply
// finishing); a reader who scrolled up is left where they are.
export function scrollsToEnd(previous: ChatMessage[], next: ChatMessage[], wasAtBottom: boolean): boolean {
  if (!wasAtBottom) return false;
  const before = new Map(previous.map((m) => [m.id, m]));
  return next.some((m) => {
    const old = before.get(m.id);
    return old === undefined || old.status !== m.status || old.text !== m.text;
  });
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
    chat: result.state.chat,
    error: keepActionError ? session.error : null,
  };
}

export const ACTION_UNREACHABLE_MESSAGE = "Couldn't reach your hatchling, so that didn't go through. Try again.";

// Record a failed action. An unreachable server also sets an explicit action error, because the
// restarting flag is cleared by the next successful fetch and the failure must outlive it.
export function actionFailed(session: Session, unreachable: boolean, message: string): Session {
  if (unreachable) {
    return { ...session, screen: applyUnreachable(session.screen), error: ACTION_UNREACHABLE_MESSAGE };
  }
  return { ...session, error: message };
}

export function setError(s: ScreenState, error: string | null): ScreenState {
  return { ...s, error };
}

export function setValue(s: ScreenState, value: string): ScreenState {
  return { ...s, value };
}
