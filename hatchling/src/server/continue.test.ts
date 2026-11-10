import { describe, expect, it } from "vitest";
import { openDb } from "../engine/db.ts";
import { EXHAUSTED_ROUNDS_PREFIX } from "../engine/nodes/enqueue.ts";
import {
  addWorkItem,
  cancelWorkItem,
  claimNext,
  failWorkItem,
  finishWorkItem,
  getWorkItem,
  type WorkItem,
} from "../engine/store.ts";
import { handleApi } from "./api.ts";
import { continueRequest } from "./continue.ts";

type Db = ReturnType<typeof openDb>;

const get = (db: Db, path: string) => handleApi(db, { method: "GET", path, body: undefined });
const post = (db: Db, path: string, body?: unknown) => handleApi(db, { method: "POST", path, body });

// A done request with done steps and a verify item that ran out of rounds.
function incomplete(db: Db, opts: { title?: string; contents?: string; steps?: string[]; findings?: string } = {}) {
  const request = addWorkItem(db, {
    kind: "request",
    title: opts.title ?? "Build a thing",
    contents: opts.contents ?? "Build a thing",
  });
  claimNext(db, "request");
  finishWorkItem(db, request.id);
  const steps: WorkItem[] = [];
  for (const title of opts.steps ?? ["Step one"]) {
    const step = addWorkItem(db, { title, parentId: request.id });
    claimNext(db, "item");
    finishWorkItem(db, step.id);
    steps.push(step);
  }
  const verify = addWorkItem(db, { kind: "verify", title: "verify", parentId: request.id });
  claimNext(db, "verify");
  failWorkItem(
    db,
    verify.id,
    opts.findings ?? `${EXHAUSTED_ROUNDS_PREFIX} 2 verification rounds. The verifier wanted: "Step more".`,
  );
  return { request, steps };
}

describe("continueRequest", () => {
  it("carries the whole original text, the built steps and the findings", () => {
    const db = openDb(":memory:");
    const original = `Build a thing\n\nrequirement on line 3 ${"x".repeat(10_500)}`;
    const { request, steps } = incomplete(db, { contents: original });
    const created = continueRequest(db, request.id);
    const id8 = request.id.slice(0, 8);
    expect(created.title).toBe("Finish: Build a thing");
    expect(created.kind).toBe("request");
    expect(created.contents).toBe(
      [
        `Finish the request ${id8} "Build a thing". Part of it was already built. Build only what is still missing and do not redo the built work.`,
        "",
        "## Original request",
        original,
        "",
        "## Already built",
        `1. ${steps[0]?.id.slice(0, 8)} Step one`,
        "",
        "## Still missing",
        "The last verification found this was still missing (these are titles only, so check the code against the original request):",
        getFindings(db, request.id),
      ].join("\n"),
    );
  });

  it("truncates long findings but not the original", () => {
    const db = openDb(":memory:");
    const findings = `${EXHAUSTED_ROUNDS_PREFIX} ${"f".repeat(3_000)}`;
    const { request } = incomplete(db, { findings, contents: `T\n${"o".repeat(5_000)}` });
    const text = continueRequest(db, request.id).contents;
    const missing = text.slice(text.indexOf("## Still missing"));
    const body = missing.split("\n").slice(2).join("\n");
    expect([...body]).toHaveLength(2_000);
    expect(body.endsWith("…")).toBe(true);
    expect(text).toContain("o".repeat(5_000));
  });

  it("keeps the last 30 built steps", () => {
    const db = openDb(":memory:");
    const { request } = incomplete(db, { steps: Array.from({ length: 32 }, (_, i) => `Step ${i + 1}`) });
    const text = continueRequest(db, request.id).contents;
    expect(text).not.toContain(" Step 2\n");
    expect(text).toContain("1. ");
    expect(text).toMatch(/ Step 3\n/);
    expect(text).toContain("30. ");
    expect(text).toContain(" Step 32\n(earlier steps left out)\n");
  });

  it("says nothing was built when there are no done steps", () => {
    const db = openDb(":memory:");
    const { request } = incomplete(db, { steps: [] });
    expect(continueRequest(db, request.id).contents).toContain("## Already built\nNothing was built.\n");
  });

  it("unwraps a continuation of a continuation", () => {
    const db = openDb(":memory:");
    const { request } = incomplete(db, { contents: "Build a thing\nrequirement on line 2" });
    const first = continueRequest(db, request.id);
    claimNext(db, "request");
    finishWorkItem(db, first.id);
    const step = addWorkItem(db, { title: "Second step", parentId: first.id });
    claimNext(db, "item");
    finishWorkItem(db, step.id);
    const verify = addWorkItem(db, { kind: "verify", title: "verify", parentId: first.id });
    claimNext(db, "verify");
    failWorkItem(db, verify.id, `${EXHAUSTED_ROUNDS_PREFIX} 2 verification rounds. The verifier wanted: "Again".`);

    const second = continueRequest(db, first.id);
    expect(second.title).toBe("Finish: Build a thing");
    expect(second.contents).not.toContain("Finish: Finish:");
    expect(second.contents.split("## Original request")).toHaveLength(2);
    expect(second.contents.split("requirement on line 2")).toHaveLength(2);
    expect(second.contents).toContain(`Finish the request ${first.id.slice(0, 8)} "Build a thing".`);
    expect(second.contents).toContain("Second step");
    expect(second.contents).not.toContain("Step one");
    expect(second.contents).toContain('"Again"');
  });

  it("refuses requests that are not incomplete, and non-requests", () => {
    const db = openDb(":memory:");
    const delivered = addWorkItem(db, { kind: "request", title: "ok" });
    claimNext(db, "request");
    finishWorkItem(db, delivered.id);
    expect(() => continueRequest(db, delivered.id)).toThrow(/^cannot continue /);

    const attention = addWorkItem(db, { kind: "request", title: "broken" });
    claimNext(db, "request");
    finishWorkItem(db, attention.id);
    const step = addWorkItem(db, { title: "s", parentId: attention.id });
    claimNext(db, "item");
    failWorkItem(db, step.id, "boom");
    expect(() => continueRequest(db, attention.id)).toThrow(/^cannot continue /);
    expect(() => continueRequest(db, step.id)).toThrow(/^cannot continue /);
  });

  it("refuses a second continuation until the first failed or was cancelled", () => {
    const db = openDb(":memory:");
    const { request } = incomplete(db);
    const first = continueRequest(db, request.id);
    expect(() => continueRequest(db, request.id)).toThrow(new RegExp(`^cannot continue .*${first.id.slice(0, 8)}`));
    cancelWorkItem(db, first.id);
    const second = continueRequest(db, request.id);
    expect(second.id).not.toBe(first.id);
    claimNext(db, "request");
    failWorkItem(db, second.id, "boom");
    expect(getWorkItem(db, second.id).status).toBe("failed");
    expect(continueRequest(db, request.id).id).not.toBe(second.id);
  });
});

describe("POST /api/items/<id>/continue", () => {
  it("creates the request and answers 201 with its id and title", () => {
    const db = openDb(":memory:");
    const { request } = incomplete(db);
    const res = post(db, `/api/items/${request.id.slice(0, 8)}/continue`, {});
    expect(res.status).toBe(201);
    const body = res.body as { id: string; title: string };
    expect(body.title).toBe("Finish: Build a thing");
    expect(getWorkItem(db, body.id).contents).toContain("## Original request");
  });

  it("maps errors", () => {
    const db = openDb(":memory:");
    expect(post(db, "/api/items/nonexistent/continue").status).toBe(404);
    expect(post(db, "/api/items/ab/continue").status).toBe(404);
    expect(post(db, "/api/items/%E0%A4%A/continue").status).toBe(400);
    const { request, steps } = incomplete(db);
    expect(post(db, `/api/items/${steps[0]?.id}/continue`).status).toBe(409);
    const verify = db.prepare("SELECT id FROM work_items WHERE kind = 'verify'").get() as { id: string };
    expect(post(db, `/api/items/${verify.id}/continue`).status).toBe(409);
    expect(post(db, `/api/items/${request.id}/continue`).status).toBe(201);
    const again = post(db, `/api/items/${request.id}/continue`);
    expect(again.status).toBe(409);
    expect((again.body as { error: string }).error).toMatch(/^cannot continue /);
  });

  it("is POST only", () => {
    const db = openDb(":memory:");
    const { request } = incomplete(db);
    expect(get(db, `/api/items/${request.id}/continue`).status).toBe(405);
  });
});

function getFindings(db: Db, requestId: string): string {
  const row = db.prepare("SELECT error FROM work_items WHERE parent_id = ? AND kind = 'verify'").get(requestId) as {
    error: string;
  };
  return row.error;
}
