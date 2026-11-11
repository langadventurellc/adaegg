import { describe, expect, it } from "vitest";
import type { NameEntry } from "../names/names.ts";
import { pickSuggestions } from "../names/suggest.ts";
import type { Delivery, RequestRow } from "../server/queue.ts";
import {
  describeDelivery,
  describeStatus,
  escapeHtml,
  progressLabel,
  RESTARTING_MESSAGE,
  renderAsk,
  renderBanner,
  renderNotFound,
  renderOnboarding,
  renderPageError,
  renderPageHeader,
  renderRequests,
  routeFor,
  screenFor,
} from "./view.ts";

const PAGE_LIST = [{ id: "tip" }, { id: "tip-calculator" }];

describe("routeFor", () => {
  it("gives the Ask screen for an empty hash", () => {
    for (const hash of ["", "#", "#/", "/"]) expect(routeFor(hash, PAGE_LIST)).toEqual({ kind: "ask" });
  });

  it("gives a known page, with or without # and a trailing slash", () => {
    for (const hash of ["#/tip", "/tip", "#/tip/"])
      expect(routeFor(hash, PAGE_LIST)).toEqual({ kind: "page", id: "tip" });
  });

  it("gives not-found for anything else, keeping the raw remainder", () => {
    expect(routeFor("#/nope", PAGE_LIST)).toEqual({ kind: "not-found", id: "nope" });
    expect(routeFor("#/tip/extra", PAGE_LIST)).toEqual({ kind: "not-found", id: "tip/extra" });
    expect(routeFor("#foo", PAGE_LIST)).toEqual({ kind: "not-found", id: "foo" });
    expect(routeFor("#/<script>", PAGE_LIST)).toEqual({ kind: "not-found", id: "<script>" });
    expect(routeFor("#/tip", [])).toEqual({ kind: "not-found", id: "tip" });
  });

  it("does not throw on malformed percent-encoding", () => {
    expect(routeFor("#/%E0%A4%A", PAGE_LIST)).toEqual({ kind: "not-found", id: "%E0%A4%A" });
  });
});

describe("page chrome", () => {
  it("renderPageHeader links back to the Ask screen and escapes the name", () => {
    const html = renderPageHeader("<b>&");
    expect(html).toContain('href="#/"');
    expect(html).toContain("Ask &lt;b&gt;&amp;");
    expect(html).not.toContain("<b>");
  });

  it("renderNotFound says so and links back", () => {
    const html = renderNotFound("Hopper");
    expect(html).toContain('href="#/"');
    expect(html).toContain("Ask Hopper");
    expect(html).toContain("This page doesn&#39;t exist.");
  });

  it("renderNotFound escapes the name", () => {
    expect(renderNotFound("<i>")).not.toContain("<i>");
  });

  it("renderPageError escapes the message", () => {
    const html = renderPageError("<img src=x> & more");
    expect(html).toContain("&lt;img src=x&gt; &amp; more");
    expect(html).not.toContain("<img");
  });
});

describe("renderAsk pages", () => {
  const pages = [
    { id: "tip", title: "Tip calculator" },
    { id: "notes", title: '<b>&"' },
  ];

  it("lists one link per page with escaped titles, before Your requests", () => {
    const html = renderAsk({ name: "Hopper", starters: [], pages });
    expect(html).toContain('<a href="#/tip">Tip calculator</a>');
    expect(html).toContain('<a href="#/notes">&lt;b&gt;&amp;&quot;</a>');
    expect(html).toContain("Your pages");
    expect(html.indexOf("Your pages")).toBeLessThan(html.indexOf("Your requests"));
  });

  it("renders no section with no pages", () => {
    expect(renderAsk({ name: "Hopper", starters: [], pages: [] })).not.toContain("Your pages");
    expect(renderAsk({ name: "Hopper", starters: [] })).not.toContain("Your pages");
  });
});

function row(over: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "abcd1234-0000-4000-8000-000000000000",
    title: "Make a tracker",
    kind: "request",
    status: "queued",
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    progress: null,
    blockedBy: [],
    delivery: null,
    followUp: null,
    ...over,
  };
}

const entry: NameEntry = { name: "Hopper", person: "Grace Hopper", knownFor: "wrote the first compiler" } as NameEntry;

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("escapeHtml", () => {
  it("escapes all five characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("renderRequests", () => {
  it("escapes titles and errors", () => {
    const html = renderRequests([
      row({ title: "<img src=x onerror=alert(1)>", status: "failed", error: '"><script>' }),
    ]);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
  });

  it("shows Retry only on failed and Cancel only on queued, with the full id", () => {
    const id = "abcd1234-0000-4000-8000-000000000000";
    const failed = renderRequests([row({ status: "failed", error: "boom" })]);
    expect(failed).toContain(`data-action="retry" data-id="${id}"`);
    expect(failed).not.toContain('data-action="cancel"');
    expect(failed).toContain("boom");
    const queued = renderRequests([row()]);
    expect(queued).toContain(`data-action="cancel" data-id="${id}"`);
    expect(queued).not.toContain('data-action="retry"');
    for (const status of ["in_progress", "done", "cancelled"] as const) {
      expect(renderRequests([row({ status })])).not.toMatch(/<button/);
    }
  });

  it("shows status text and progress", () => {
    const html = renderRequests([row({ status: "in_progress", progress: { done: 2, total: 5 } })]);
    expect(html).toContain("Working");
    expect(html).toContain("2 of 5 done");
  });

  it("shows an empty state inside the live region", () => {
    const html = renderRequests([]);
    expect(html).toContain("No requests yet. Ask for something above.");
    expect(html).toContain('aria-live="polite"');
    expect(renderRequests([row()])).toContain('aria-live="polite"');
  });
});

describe("delivery rows", () => {
  const rid = "abcd1234-0000-4000-8000-000000000000";
  const stepId = "step0000-0000-4000-8000-000000000000";
  const d = (state: Delivery["state"], attention: Delivery["attention"] = null): Delivery => ({ state, attention });

  it("labels each state", () => {
    const labels: [Delivery["state"], string][] = [
      ["planning", "Waiting"],
      ["building", "Building"],
      ["verifying", "Checking the result"],
      ["delivered", "Delivered"],
      ["needs-attention", "Needs attention"],
      ["incomplete", "Incomplete"],
      ["failed", "Failed"],
      ["cancelled", "Cancelled"],
    ];
    for (const [state, label] of labels) {
      expect(describeDelivery(d(state), row())).toBe(label);
      const html = renderRequests([row({ status: state === "planning" ? "queued" : "done", delivery: d(state) })]);
      expect(html).toContain(`data-status="${state}"`);
      expect(html).toContain(`>${label}</span>`);
    }
    expect(describeDelivery(d("planning"), row({ status: "in_progress" }))).toBe("Working");
    expect(describeDelivery(d("planning"), row({ blockedBy: ["x"] }))).toBe("Waiting for other work");
  });

  it("names the failing step and retries that step, not the request", () => {
    const attention = { id: stepId, title: "Build it", error: "boom", action: "retry" as const };
    const html = renderRequests([row({ status: "done", delivery: d("needs-attention", attention) })]);
    expect(html).toContain("Build it failed: boom");
    expect(html).toContain(`data-action="retry" data-id="${stepId}"`);
    expect(html).not.toContain(`${rid}"`);
    const cancelled = renderRequests([
      row({ status: "done", delivery: d("needs-attention", { ...attention, error: null }) }),
    ]);
    expect(cancelled).toContain("Build it was cancelled");
  });

  it("offers Ask for the rest and no Retry when incomplete", () => {
    const attention = { id: stepId, title: "Check", error: "gave up", action: "ask-again" as const };
    const html = renderRequests([
      row({ title: 'A "quoted" <b>', status: "done", delivery: d("incomplete", attention) }),
    ]);
    expect(html).toContain("The request may still be missing work. gave up");
    expect(html).not.toContain('data-action="retry"');
    expect(html).toContain(`<button type="button" data-action="continue" data-id="${rid}">Ask for the rest</button>`);
    expect(html).not.toContain("data-text");
    expect(html).not.toContain("starter");
  });

  it("keeps a long row title out of the Ask for the rest button", () => {
    const title = "T".repeat(200);
    const attention = { id: stepId, title: "Check", error: "gave up", action: "ask-again" as const };
    const html = renderRequests([row({ title, status: "done", delivery: d("incomplete", attention) })]);
    const button = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
    expect(button).toContain('data-action="continue"');
    expect(button).not.toContain("TTTT");
  });

  it("shows only the error for a failed request and omits an empty one", () => {
    const attention = { id: rid, title: "Make a tracker", error: "bad", action: "retry" as const };
    const failed = renderRequests([row({ status: "failed", delivery: d("failed", attention) })]);
    expect(failed).toContain('<p class="request-error">bad</p>');
    expect(failed).toContain(`data-action="retry" data-id="${rid}"`);
    const cancelled = renderRequests([
      row({ status: "cancelled", delivery: d("cancelled", { ...attention, error: null }) }),
    ]);
    expect(cancelled).not.toContain("request-error");
    expect(cancelled).toContain('data-action="retry"');
  });

  it("shows no buttons for delivered, building and verifying, and keeps Cancel when queued", () => {
    for (const state of ["delivered", "building", "verifying"] as const) {
      expect(renderRequests([row({ status: "done", delivery: d(state) })])).not.toMatch(/<button/);
    }
    const queued = renderRequests([row({ delivery: d("planning") })]);
    expect(queued).toContain(`data-action="cancel" data-id="${rid}"`);
  });

  it("omits progress when delivered only", () => {
    const progress = { done: 2, total: 2 };
    expect(renderRequests([row({ status: "done", progress, delivery: d("delivered") })])).not.toContain("progress");
    expect(renderRequests([row({ status: "done", progress, delivery: d("building") })])).toContain("2 of 2 done");
  });

  it("escapes the step title and error", () => {
    const attention = { id: stepId, title: "<img src=x>", error: "<script>", action: "retry" as const };
    const html = renderRequests([row({ status: "done", delivery: d("needs-attention", attention) })]);
    expect(html).toContain("&lt;img src=x&gt; failed: &lt;script&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
  });
});

describe("incomplete rows with a follow-up", () => {
  const rid = "abcd1234-0000-4000-8000-000000000000";
  const fid = "feed0000-0000-4000-8000-000000000000";
  const d = (state: Delivery["state"], attention: Delivery["attention"] = null): Delivery => ({ state, attention });
  const attention = { id: "step0000", title: "Check", error: "gave up", action: "ask-again" as const };
  const followUp = (
    state: Delivery["state"],
    over: Partial<NonNullable<RequestRow["followUp"]>> = {},
  ): NonNullable<RequestRow["followUp"]> => ({
    id: fid,
    title: "Finish: Make a tracker",
    status: "in_progress",
    blockedBy: [],
    progress: null,
    delivery: d(state),
    ...over,
  });
  const render = (fu: RequestRow["followUp"], att: Delivery["attention"] = attention) =>
    renderRequests([row({ status: "done", delivery: d("incomplete", att), followUp: fu })]);

  it("shows the follow-up's progress or outcome", () => {
    const cases: [Delivery["state"], { done: number; total: number } | null, string][] = [
      ["planning", null, "Working"],
      ["building", { done: 1, total: 2 }, "Building (1 of 2 done)"],
      ["verifying", { done: 2, total: 2 }, "Checking the result (2 of 2 done)"],
      ["delivered", { done: 2, total: 2 }, "Delivered"],
      ["needs-attention", { done: 1, total: 2 }, "Needs attention (1 of 2 done) Retry it in its own row."],
    ];
    for (const [state, progress, label] of cases) {
      const html = render(followUp(state, { progress }));
      expect(html).toContain('data-status="continued"');
      expect(html).toContain('<span class="status">Continued</span>');
      expect(html).toContain(
        `<p class="request-followup" data-follow-up-id="${fid}">The rest of this request was sent as “Finish: Make a tracker”: ${label}</p>`,
      );
      expect(html).toContain('<p class="request-history">The first check found: gave up</p>');
      expect(html).not.toContain("data-action");
      expect(html).not.toContain("request-error");
      expect(html).not.toContain("Incomplete");
    }
    expect(render(followUp("planning"))).not.toContain("Retry it");
  });

  it("omits the history line without an error", () => {
    expect(render(followUp("planning"), { ...attention, error: null })).not.toContain("request-history");
  });

  it("escapes the follow-up title and the findings", () => {
    const html = render(followUp("planning", { title: `<b>"a" & b` }), { ...attention, error: `<i>"x" & y` });
    expect(html).toContain("&lt;b&gt;&quot;a&quot; &amp; b");
    expect(html).toContain("&lt;i&gt;&quot;x&quot; &amp; y");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
  });

  it("renders as before without a follow-up", () => {
    const html = render(null);
    expect(html).toContain("The request may still be missing work. gave up");
    expect(html).toContain(`data-action="continue" data-id="${rid}">Ask for the rest</button>`);
    expect(html).toContain('data-status="incomplete"');
  });

  it("keeps Cancel on a queued original", () => {
    const html = renderRequests([
      row({ status: "queued", delivery: d("incomplete", attention), followUp: followUp("planning") }),
    ]);
    expect(html).toContain(`data-action="cancel" data-id="${rid}"`);
  });
});

describe("describeStatus and progressLabel", () => {
  it("labels each status", () => {
    expect(describeStatus(row())).toBe("Waiting");
    expect(describeStatus(row({ blockedBy: ["x"] }))).toBe("Waiting for other work");
    expect(describeStatus(row({ status: "in_progress" }))).toBe("Working");
    expect(describeStatus(row({ status: "done" }))).toBe("Done");
    expect(describeStatus(row({ status: "failed", error: "e" }))).toBe("Failed");
    expect(describeStatus(row({ status: "cancelled" }))).toBe("Cancelled");
  });

  it("formats progress", () => {
    expect(progressLabel({ done: 2, total: 5 })).toBe("2 of 5 done");
    expect(progressLabel(null)).toBe("");
  });
});

describe("renderAsk", () => {
  it("renders the form, starters and requests", () => {
    const html = renderAsk({ name: "Hopper", starters: ["Track my books", 'A "quoted" one'] });
    expect(html).toContain("<h1>Ask Hopper</h1>");
    expect(html).toMatch(/<label for="ask-text">/);
    expect(html).toMatch(/<textarea id="ask-text"/);
    expect(html).toContain('id="ask-form"');
    expect(html).toContain('id="requests"');
    expect(html).toContain('data-text="Track my books"');
    expect(html).toContain('data-text="A &quot;quoted&quot; one"');
    expect(html).toContain("Not sure where to start?");
    expect(html).toContain("Your requests");
    expect(html).toContain('data-action="rename">Change name');
  });

  it("escapes the name and includes given requests", () => {
    const html = renderAsk({ name: "<b>x</b>", starters: [], requests: [row({ title: "Mine" })] });
    expect(html).toContain("Ask &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("Mine");
  });
});

describe("renderOnboarding", () => {
  const base = { suggestion: entry, value: "Hopper", error: null, current: null };

  it("shows the suggestion and a prefilled input", () => {
    const html = renderOnboarding(base);
    expect(html).toContain("Name your hatchling");
    expect(html).toContain("How about <b>Hopper</b>? Named for Grace Hopper, who wrote the first compiler.");
    expect(html).toMatch(/<label for="name-input">/);
    expect(html).toMatch(/<input id="name-input"[^>]*value="Hopper"/);
    expect(html).toContain('id="name-form"');
    expect(html).toContain("Choose this name");
    expect(html).toContain('data-action="another"');
    expect(html).toContain("Another suggestion");
    expect(html).not.toContain("role=");
  });

  it("shows the error with role alert only when given", () => {
    const html = renderOnboarding({ ...base, error: "Too <long>" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Too &lt;long&gt;");
  });

  it("omits the suggestion paragraph without a suggestion and escapes the value", () => {
    const html = renderOnboarding({ ...base, suggestion: null, value: '"><x' });
    expect(html).not.toContain('class="suggestion"');
    expect(html).toContain('value="&quot;&gt;&lt;x"');
  });

  it("renames when current is set", () => {
    expect(renderOnboarding({ ...base, current: "Hopper" })).toContain("Rename Hopper");
    expect(renderOnboarding({ ...base, current: "<i>" })).toContain("Rename &lt;i&gt;");
  });

  it("never suggests Ada", () => {
    const random = seeded(42);
    for (let i = 0; i < 500; i++) {
      for (const e of pickSuggestions(random, 3)) {
        const html = renderOnboarding({ suggestion: e, value: e.name, error: null, current: null });
        const paragraph = /<p class="suggestion">.*?<\/p>/.exec(html);
        expect(paragraph).not.toBeNull();
        expect(paragraph?.[0]).not.toMatch(/\bAda\b/i);
      }
    }
  });
});

describe("renderBanner", () => {
  it("renders restarting as a status", () => {
    const html = renderBanner("restarting", RESTARTING_MESSAGE);
    expect(RESTARTING_MESSAGE).toBe("Your hatchling is restarting. This page will reconnect by itself.");
    expect(html).toContain(RESTARTING_MESSAGE);
    expect(html).toContain('role="status"');
    expect(html).toContain("banner-restarting");
  });

  it("renders error as an alert and escapes", () => {
    const html = renderBanner("error", "<oops>");
    expect(html).toContain('role="alert"');
    expect(html).toContain("banner-error");
    expect(html).toContain("&lt;oops&gt;");
  });
});

describe("screenFor", () => {
  it("covers all combinations", () => {
    const named = { name: "Hopper" };
    const unnamed = { name: null };
    for (const editing of [false, true]) {
      for (const state of [null, unnamed, named]) {
        expect(screenFor(state, editing, true)).toBe("unreachable");
      }
    }
    expect(screenFor(null, false, false)).toBe("onboarding");
    expect(screenFor(unnamed, false, false)).toBe("onboarding");
    expect(screenFor(unnamed, true, false)).toBe("onboarding");
    expect(screenFor(named, true, false)).toBe("onboarding");
    expect(screenFor(named, false, false)).toBe("ask");
  });
});
