import "./style.css";
import { validateName } from "../names/validate.ts";
import { ApiError, createClient, UnreachableError } from "./client.ts";
import { PAGES, type Page } from "./pages/index.ts";
import { pickStarters } from "./starters.ts";
import {
  actionFinished,
  anotherSuggestion,
  applyFetchResult,
  applyUnreachable,
  type ChatState,
  canSend,
  type FetchResult,
  initialSession,
  isSendKey,
  nameSaved,
  pollDelayMs,
  type Session,
  scrollsToEnd,
  setError,
  setValue,
  startRename,
} from "./state.ts";
import {
  hasOtherRequests,
  RESTARTING_MESSAGE,
  renderAsk,
  renderBanner,
  renderNotFound,
  renderOnboarding,
  renderOtherRequests,
  renderPageError,
  renderPageHeader,
  renderThread,
  routeFor,
  screenFor,
} from "./view.ts";

// A thin shell: every decision and every piece of markup comes from the tested pure modules
// (state.ts, view.ts, starters.ts, client.ts). Nothing here is covered by tests (no DOM environment).

const app = document.querySelector<HTMLElement>("#app");
const client = createClient("");
const starters = pickStarters(Math.random);

let session: Session = initialSession();
let shownScreen: string | null = null;
let shownSuggestion = false;
let pageCleanup: (() => void) | null = null;
let polling = false; // only polls are single-flight; a refresh after an action always runs

function currentScreen(): "onboarding" | "ask" {
  const { state, editingName } = session.screen;
  return screenFor(state, editingName, false) === "ask" ? "ask" : "onboarding";
}

function bannerHtml(): string {
  if (session.screen.unreachable) return renderBanner("restarting", RESTARTING_MESSAGE);
  if (session.error !== null) return renderBanner("error", session.error);
  return "";
}

function renderBannerSlot(): void {
  const slot = document.querySelector("#banner");
  if (slot) slot.innerHTML = bannerHtml();
}

let shownMessages: ChatState["messages"] = [];

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 8;
}

// Swaps only the thread, the other requests and the Send button; the form is never replaced,
// so a draft and focus survive.
function renderAskSlots(): void {
  const { messages, busy } = session.chat;
  const thread = document.querySelector<HTMLElement>("#thread");
  if (thread) {
    const wasAtBottom = atBottom(thread);
    thread.innerHTML = renderThread(messages, session.rows);
    if (scrollsToEnd(shownMessages, messages, wasAtBottom)) thread.scrollTop = thread.scrollHeight;
  }
  shownMessages = messages;
  const other = document.querySelector<HTMLElement>("#other-requests");
  if (other) {
    other.innerHTML = renderOtherRequests(messages, session.rows);
    const section = other.parentElement;
    if (section) section.hidden = !hasOtherRequests(messages, session.rows);
  }
  const starters = document.querySelector<HTMLElement>(".starters");
  if (starters) starters.hidden = messages.length > 0;
  const send = document.querySelector<HTMLButtonElement>("#ask-form button[type=submit]");
  if (send) send.disabled = busy;
}

// Onboarding wins over the hash; the route only matters on the ask screen.
function currentView(): string {
  if (currentScreen() === "onboarding") return "onboarding";
  const route = routeFor(location.hash, PAGES);
  return route.kind === "ask" ? "ask" : `${route.kind}:${route.id}`;
}

function leavePage(): void {
  const cleanup = pageCleanup;
  pageCleanup = null;
  try {
    cleanup?.();
  } catch {
    // A page's cleanup failing must not break the shell.
  }
}

function fullRender(): void {
  if (!app) return;
  leavePage();
  const s = session.screen;
  const name = s.state?.name ?? "";
  const view = currentView();
  const route = routeFor(location.hash, PAGES);
  let title = "Ada Egg";
  let body: string;
  let page: Page | undefined;
  if (view === "onboarding") {
    body = renderOnboarding({ suggestion: s.suggestion, value: s.value, error: s.error, current: s.current });
  } else if (route.kind === "page") {
    page = PAGES.find((p) => p.id === route.id);
    title = page?.title ?? `Ask ${name}`;
    body = `${renderPageHeader(name)}<div id="page-root"></div>`;
  } else if (route.kind === "not-found") {
    title = `Ask ${name}`;
    body = renderNotFound(name);
  } else {
    title = `Ask ${name}`;
    body = renderAsk({ name, starters, requests: session.rows, pages: PAGES, chat: session.chat });
  }
  app.innerHTML = `<div id="banner">${bannerHtml()}</div><main>${body}</main>`;
  document.title = title;
  shownScreen = view;
  shownSuggestion = s.suggestion !== null;
  shownMessages = session.chat.messages;
  const thread = document.querySelector<HTMLElement>("#thread");
  if (thread) thread.scrollTop = thread.scrollHeight;
  const root = document.querySelector<HTMLElement>("#page-root");
  if (page && root) {
    try {
      const cleanup = page.render(root);
      if (typeof cleanup === "function") pageCleanup = cleanup;
    } catch (err) {
      root.innerHTML = renderPageError(describe(err));
    }
  }
}

function render(): void {
  // A suggestion that arrives late (first load failed) redraws onboarding once; after that the form is the user's.
  const lateSuggestion = shownScreen === "onboarding" && !shownSuggestion && session.screen.suggestion !== null;
  if (currentView() !== shownScreen || lateSuggestion) fullRender();
  else {
    renderBannerSlot();
    // Only the Ask screen has the thread; a page's own DOM is never touched by a poll.
    if (shownScreen === "ask") renderAskSlots();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

async function refresh(keepActionError = false, isPoll = false): Promise<void> {
  if (isPoll) {
    if (polling) return;
    polling = true;
  }
  const startedEpoch = session.epoch;
  let result: FetchResult;
  try {
    result = { kind: "state", state: await client.getState() };
  } catch (err) {
    result = err instanceof UnreachableError ? { kind: "unreachable" } : { kind: "error", message: describe(err) };
  } finally {
    if (isPoll) polling = false;
  }
  // An answer that predates a finished action is dropped inside applyFetchResult.
  session = applyFetchResult(session, startedEpoch, result, Math.random, keepActionError);
  render();
}

// Run after an action's API call returns, so any fetch already in flight counts as stale.
async function refreshAfterAction(keepActionError: boolean): Promise<void> {
  session = actionFinished(session);
  await refresh(keepActionError);
}

function focusById(id: string, select = false): void {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  el?.focus();
  if (select) el?.select();
}

async function withDisabled(button: HTMLButtonElement | null, work: () => Promise<void>): Promise<void> {
  if (button) button.disabled = true;
  try {
    await work();
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitName(form: HTMLFormElement): Promise<void> {
  const input = form.querySelector<HTMLInputElement>("#name-input");
  const raw = input?.value ?? "";
  session = { ...session, screen: setValue(session.screen, raw) };
  const checked = validateName(raw);
  if (!checked.ok) {
    session = { ...session, screen: setError(session.screen, checked.error) };
    fullRender();
    focusById("name-input");
    return;
  }
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  await withDisabled(button, async () => {
    try {
      const saved = await client.setName(checked.name);
      session = { ...session, screen: nameSaved(session.screen, saved.name), error: null };
      fullRender();
      focusById("ask-text");
      await refreshAfterAction(false);
    } catch (err) {
      if (err instanceof ApiError) {
        session = { ...session, screen: setError(session.screen, err.message) };
      } else if (err instanceof UnreachableError) {
        session = { ...session, screen: applyUnreachable(session.screen) };
      } else {
        session = { ...session, error: describe(err) };
      }
      fullRender();
      focusById("name-input");
    }
  });
}

// Runs an API call for an action, records its failure, then refreshes at once.
async function runAction(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
    session = { ...session, error: null };
  } catch (err) {
    if (err instanceof UnreachableError) session = { ...session, screen: applyUnreachable(session.screen) };
    else session = { ...session, error: describe(err) };
  }
  await refreshAfterAction(session.error !== null);
  renderBannerSlot();
}

// Sends one chat message; resolves true when the server accepted it.
async function sendChat(text: string): Promise<boolean> {
  let sent = false;
  await runAction(async () => {
    await client.chat(text);
    sent = true;
  });
  return sent;
}

async function submitAsk(form: HTMLFormElement): Promise<void> {
  const textarea = form.querySelector<HTMLTextAreaElement>("#ask-text");
  const text = textarea?.value.trim() ?? "";
  if (!canSend(text, session.chat.busy)) {
    textarea?.focus();
    return;
  }
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  await withDisabled(button, async () => {
    const sent = await sendChat(text);
    if (sent && textarea) textarea.value = "";
    textarea?.focus();
  });
}

async function itemAction(button: HTMLButtonElement, action: "retry" | "cancel" | "continue"): Promise<void> {
  const id = button.dataset.id;
  if (!id) return;
  await withDisabled(button, () => runAction(() => client[action](id)));
}

app?.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  switch (button.dataset.action) {
    case "another": {
      session = { ...session, screen: anotherSuggestion(session.screen, Math.random) };
      fullRender();
      focusById("name-input", true);
      break;
    }
    case "rename": {
      session = { ...session, screen: startRename(session.screen) };
      fullRender();
      focusById("name-input", true);
      break;
    }
    case "starter": {
      const text = (button.dataset.text ?? "").trim();
      if (canSend(text, session.chat.busy)) void sendChat(text);
      break;
    }
    case "retry":
    case "cancel":
    case "continue":
      void itemAction(button, button.dataset.action);
      break;
  }
});

app?.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  if (form.id === "name-form") void submitName(form);
  else if (form.id === "ask-form") void submitAsk(form);
});

app?.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.id !== "ask-text") return;
  if (!isSendKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.isComposing })) return;
  event.preventDefault();
  target.closest("form")?.requestSubmit();
});

function schedulePoll(): void {
  setTimeout(async () => {
    if (!document.hidden) await refresh(false, true);
    schedulePoll();
  }, pollDelayMs(session));
}

window.addEventListener("hashchange", () => {
  // Before the first state arrives there is nothing to draw; the first render picks up the hash.
  if (shownScreen !== null) fullRender();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh(false, true);
});

void refresh(false, true).then(() => {
  // The first render is always a full one, whatever the screen is.
  if (shownScreen === null) fullRender();
  schedulePoll();
});
