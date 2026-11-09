import "./style.css";
import { validateName } from "../names/validate.ts";
import type { RequestRow } from "../server/queue.ts";
import { ApiError, createClient, UnreachableError } from "./client.ts";
import { pickStarters } from "./starters.ts";
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
import { RESTARTING_MESSAGE, renderAsk, renderBanner, renderOnboarding, renderRequests, screenFor } from "./view.ts";

// A thin shell: every decision and every piece of markup comes from the tested pure modules
// (state.ts, view.ts, starters.ts, client.ts). Nothing here is covered by tests (no DOM environment).

const POLL_MS = 3000;
const app = document.querySelector<HTMLElement>("#app");
const client = createClient("");
const starters = pickStarters(Math.random);

let s: ScreenState = initialState();
let rows: RequestRow[] = [];
let errorMessage: string | null = null;
let shownScreen: string | null = null;
let shownSuggestion = false;
let polling = false;

function currentScreen(): "onboarding" | "ask" {
  return screenFor(s.state, s.editingName, false) === "ask" ? "ask" : "onboarding";
}

function bannerHtml(): string {
  if (s.unreachable) return renderBanner("restarting", RESTARTING_MESSAGE);
  if (errorMessage !== null) return renderBanner("error", errorMessage);
  return "";
}

function renderBannerSlot(): void {
  const slot = document.querySelector("#banner");
  if (slot) slot.innerHTML = bannerHtml();
}

function renderRequestsSlot(): void {
  const slot = document.querySelector("#requests");
  if (slot) slot.innerHTML = renderRequests(rows);
}

function fullRender(): void {
  if (!app) return;
  const screen = currentScreen();
  const body =
    screen === "ask"
      ? renderAsk({ name: s.state?.name ?? "", starters, requests: rows })
      : renderOnboarding({ suggestion: s.suggestion, value: s.value, error: s.error, current: s.current });
  app.innerHTML = `<div id="banner">${bannerHtml()}</div><main>${body}</main>`;
  document.title = screen === "ask" ? `Ask ${s.state?.name ?? ""}` : "Ada Egg";
  shownScreen = screen;
  shownSuggestion = s.suggestion !== null;
}

function render(): void {
  // A suggestion that arrives late (first load failed) redraws onboarding once; after that the form is the user's.
  const lateSuggestion = shownScreen === "onboarding" && !shownSuggestion && s.suggestion !== null;
  if (currentScreen() !== shownScreen || lateSuggestion) fullRender();
  else {
    renderBannerSlot();
    renderRequestsSlot();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

async function refresh(keepActionError = false): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const fetched = await client.getState();
    rows = fetched.queue.requests;
    s = applyFetched(s, fetched, Math.random);
    errorMessage = errorAfterRefresh(errorMessage, keepActionError);
  } catch (err) {
    if (err instanceof UnreachableError) s = applyUnreachable(s);
    else errorMessage = describe(err);
  } finally {
    polling = false;
  }
  render();
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
  s = setValue(s, raw);
  const checked = validateName(raw);
  if (!checked.ok) {
    s = setError(s, checked.error);
    fullRender();
    focusById("name-input");
    return;
  }
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  await withDisabled(button, async () => {
    try {
      const saved = await client.setName(checked.name);
      s = nameSaved(s, saved.name);
      errorMessage = null;
      fullRender();
      focusById("ask-text");
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        s = setError(s, err.message);
      } else if (err instanceof UnreachableError) {
        s = applyUnreachable(s);
      } else {
        errorMessage = describe(err);
      }
      fullRender();
      focusById("name-input");
    }
  });
}

async function submitAsk(form: HTMLFormElement): Promise<void> {
  const textarea = form.querySelector<HTMLTextAreaElement>("#ask-text");
  const text = textarea?.value.trim() ?? "";
  if (text === "") {
    textarea?.focus();
    return;
  }
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  await withDisabled(button, async () => {
    try {
      await client.ask(text);
      if (textarea) textarea.value = "";
      errorMessage = null;
    } catch (err) {
      if (err instanceof UnreachableError) s = applyUnreachable(s);
      else errorMessage = describe(err);
    }
    await refresh(errorMessage !== null);
    renderBannerSlot();
    textarea?.focus();
  });
}

async function itemAction(button: HTMLButtonElement, action: "retry" | "cancel"): Promise<void> {
  const id = button.dataset.id;
  if (!id) return;
  await withDisabled(button, async () => {
    try {
      await client[action](id);
      errorMessage = null;
    } catch (err) {
      if (err instanceof UnreachableError) s = applyUnreachable(s);
      else errorMessage = describe(err);
    }
    await refresh(errorMessage !== null);
    renderBannerSlot();
  });
}

app?.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  switch (button.dataset.action) {
    case "another": {
      s = anotherSuggestion(s, Math.random);
      fullRender();
      focusById("name-input", true);
      break;
    }
    case "rename": {
      s = startRename(s);
      fullRender();
      focusById("name-input", true);
      break;
    }
    case "starter": {
      const textarea = document.querySelector<HTMLTextAreaElement>("#ask-text");
      if (textarea) {
        textarea.value = button.dataset.text ?? "";
        textarea.focus();
      }
      break;
    }
    case "retry":
    case "cancel":
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

setInterval(() => {
  if (!document.hidden) void refresh();
}, POLL_MS);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});

void refresh().then(() => {
  // The first render is always a full one, whatever the screen is.
  if (shownScreen === null) fullRender();
});
