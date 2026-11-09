import { describe, expect, it } from "vitest";
import { openDb } from "../db.ts";
import type { Plan } from "../plan.ts";
import { addWorkItem, getWorkItem, type ListedWorkItem, listWorkItems } from "../store.ts";
import { EXHAUSTED_ROUNDS_PREFIX, enqueueNode } from "./enqueue.ts";
import { builtinNodeTypes } from "./index.ts";
import { makeCtx } from "./test-repo.ts";

type Listed = ListedWorkItem;

function plan(...items: Array<[string, string, string[]?]>): Plan {
  return {
    summary: "the summary",
    items: items.map(([key, title, dependsOn]) => ({ key, title, contents: `do ${key}`, dependsOn: dependsOn ?? [] })),
  };
}

function setup(workItem: Parameters<typeof addWorkItem>[1], p: Plan | null, maxVerifyRounds = 2) {
  const db = openDb(":memory:");
  const item = addWorkItem(db, workItem);
  const ctx = { ...makeCtx("/nowhere", { db, workItem: item, state: { plan: p } }), config: { maxVerifyRounds } };
  return { db, item, ctx };
}

function run(ctx: ReturnType<typeof setup>["ctx"]) {
  return enqueueNode.run(ctx as never);
}

const request = { title: "Big request", contents: "Do it all", kind: "request", priority: 3 };

describe("enqueue node", () => {
  it("is registered", () => {
    expect(builtinNodeTypes.enqueue?.outcomes).toEqual(["queued", "failed"]);
  });

  it("creates chained items and a verification", async () => {
    const { db, item, ctx } = setup(request, plan(["a", "A"], ["b", "B"], ["c", "C", ["a", "b"]]));
    expect((await run(ctx)).outcome).toBe("queued");
    const all = listWorkItems(db).filter((i) => i.id !== item.id);
    expect(all).toHaveLength(4);
    const [a, b, c, verify] = all as [Listed, Listed, Listed, Listed];
    for (const i of [a, b, c]) {
      expect(i.kind).toBe("item");
      expect(i.parentId).toBe(item.id);
      expect(i.sourceId).toBe(item.id);
      expect(i.priority).toBe(3);
    }
    expect(a.contents).toBe(`Part of the request ${item.id.slice(0, 8)} "Big request".\n\ndo a`);
    expect(a.blockedBy).toEqual([]);
    expect(c.blockedBy).toEqual([a.id, b.id]);
    expect(verify.kind).toBe("verify");
    expect(verify.parentId).toBe(item.id);
    expect(verify.sourceId).toBe(item.id);
    expect(verify.title).toBe("Verify: Big request");
    expect(verify.blockedBy).toEqual([a.id, b.id, c.id]);
    expect(verify.contents).toContain("Big request");
    expect(verify.contents).toContain("Do it all");
    expect(verify.contents).toContain(`1. ${a.id.slice(0, 8)} A`);
    expect(verify.contents).toContain(`3. ${c.id.slice(0, 8)} C`);
    expect(verify.contents).toContain("Round 1 of 2");
  });

  it("gives a one-item request no verification", async () => {
    const { db, item, ctx } = setup(request, plan(["a", "A"]));
    expect((await run(ctx)).outcome).toBe("queued");
    const others = listWorkItems(db).filter((i) => i.id !== item.id);
    expect(others.map((i) => i.kind)).toEqual(["item"]);
  });

  it("fails on an empty plan for a request", async () => {
    const { db, ctx } = setup(request, { summary: "already there", items: [] });
    const result = await run(ctx);
    expect(result).toEqual({ outcome: "failed", problem: "the planner found nothing to build: already there" });
    expect(listWorkItems(db)).toHaveLength(1);
  });

  it("queues nothing for an empty plan on a verify item", async () => {
    const db = openDb(":memory:");
    const root = addWorkItem(db, request);
    const verify = addWorkItem(db, { title: "v", kind: "verify", parentId: root.id });
    const ctx = {
      ...makeCtx("/x", { db, workItem: verify, state: { plan: { summary: "ok", items: [] } } }),
      config: { maxVerifyRounds: 2 },
    };
    expect((await enqueueNode.run(ctx as never)).outcome).toBe("queued");
    expect(listWorkItems(db)).toHaveLength(2);
  });

  it("adds items and the next verification for a verify item", async () => {
    const db = openDb(":memory:");
    const root = addWorkItem(db, request);
    const verify = addWorkItem(db, { title: "v", kind: "verify", parentId: root.id });
    const ctx = {
      ...makeCtx("/x", { db, workItem: verify, state: { plan: plan(["m", "Missing"]) } }),
      config: { maxVerifyRounds: 2 },
    };
    expect((await enqueueNode.run(ctx as never)).outcome).toBe("queued");
    const created = listWorkItems(db).filter((i) => i.sourceId === verify.id);
    expect(created.map((i) => i.kind)).toEqual(["item", "verify"]);
    expect(created.every((i) => i.parentId === root.id)).toBe(true);
    expect(created[1]?.contents).toContain("Round 2 of 2");
  });

  it("fails at the round limit and creates nothing", async () => {
    const db = openDb(":memory:");
    const root = addWorkItem(db, request);
    const verify = addWorkItem(db, { title: "v", kind: "verify", parentId: root.id });
    const ctx = {
      ...makeCtx("/x", { db, workItem: verify, state: { plan: plan(["m", "Missing one"], ["n", "Missing two"]) } }),
      config: { maxVerifyRounds: 1 },
    };
    const result = await enqueueNode.run(ctx as never);
    expect(result.outcome).toBe("failed");
    expect(result.problem).toContain("maxVerifyRounds");
    expect(result.problem?.startsWith(EXHAUSTED_ROUNDS_PREFIX)).toBe(true);
    expect(result.problem).toContain('"Missing one", "Missing two"');
    expect(result.problem).toContain(`hatch show ${root.id.slice(0, 8)}`);
    expect(listWorkItems(db)).toHaveLength(2);
  });

  it("does not duplicate on a second run", async () => {
    const { db, ctx } = setup(request, plan(["a", "A"], ["b", "B"]));
    await run(ctx);
    const count = listWorkItems(db).length;
    expect((await run(ctx)).outcome).toBe("queued");
    expect(listWorkItems(db)).toHaveLength(count);
  });

  it("fails for a verify item without a parent", async () => {
    const { ctx } = setup({ title: "v", kind: "verify" }, plan(["a", "A"]));
    expect(await run(ctx)).toEqual({ outcome: "failed", problem: "verify item has no parent request" });
  });

  it("fails for an item-kind work item", async () => {
    const { ctx } = setup({ title: "i" }, plan(["a", "A"]));
    expect(await run(ctx)).toEqual({
      outcome: "failed",
      problem: "enqueue needs a request or verify work item, got kind item",
    });
  });

  it("fails without a plan", async () => {
    const { ctx } = setup(request, null);
    expect(await run(ctx)).toEqual({ outcome: "failed", problem: "no plan in the run state" });
  });

  it("cuts a long title in the verification", async () => {
    const { db, ctx } = setup({ ...request, title: "x".repeat(150) }, plan(["a", "A"], ["b", "B"]));
    await run(ctx);
    const verify = listWorkItems(db).find((i) => i.kind === "verify");
    expect(verify?.title).toHaveLength(100);
    expect(verify?.title.startsWith("Verify: xxx")).toBe(true);
  });

  it("rolls back with an outer transaction", async () => {
    const { db, item, ctx } = setup(request, plan(["a", "A"], ["b", "B"]));
    db.exec("BEGIN");
    await run(ctx);
    db.exec("ROLLBACK");
    expect(listWorkItems(db).map((i) => i.id)).toEqual([getWorkItem(db, item.id).id]);
  });
});
