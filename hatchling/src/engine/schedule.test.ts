import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { fireDueSchedules } from "./schedule.ts";
import { addWorkItem, listWorkItems } from "./store.ts";
import type { Workflow } from "./workflows/schema.ts";

function cron(schedule = "17 3 * * *"): Workflow {
  return {
    id: "tidy",
    name: "Tidy",
    trigger: { type: "cron", schedule },
    start: "a",
    nodes: [{ id: "a", type: "a", config: {} }],
    edges: [{ from: "a", on: "ok", to: "end" }],
  };
}

const lastChecked = (db: DatabaseSync) =>
  (db.prepare("SELECT last_checked_at FROM schedules WHERE workflow_id = 'tidy'").get() as { last_checked_at: string })
    .last_checked_at;
const count = (db: DatabaseSync) => (db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n;

let db: DatabaseSync;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("fireDueSchedules", () => {
  it("inserts a row on first sight and fires nothing", () => {
    const now = new Date(2026, 0, 5, 10, 0);
    expect(fireDueSchedules(db, [cron()], now)).toEqual([]);
    expect(lastChecked(db)).toBe(now.toISOString());
    expect(count(db)).toBe(0);
  });

  it("fires nothing before the next slot and leaves the row alone", () => {
    const start = new Date(2026, 0, 5, 10, 0);
    fireDueSchedules(db, [cron()], start);
    expect(fireDueSchedules(db, [cron()], new Date(2026, 0, 6, 3, 16))).toEqual([]);
    expect(lastChecked(db)).toBe(start.toISOString());
    expect(count(db)).toBe(0);
  });

  it("fires one item with the workflow's kind and name at the slot", () => {
    fireDueSchedules(db, [cron()], new Date(2026, 0, 5, 10, 0));
    const now = new Date(2026, 0, 6, 3, 17);
    expect(fireDueSchedules(db, [cron()], now)).toEqual(["tidy"]);
    const items = listWorkItems(db);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("tidy");
    expect(items[0]?.title).toBe("Tidy");
    expect(lastChecked(db)).toBe(now.toISOString());
  });

  it("fires once for many missed slots", () => {
    fireDueSchedules(db, [cron()], new Date(2026, 0, 1, 0, 0));
    expect(fireDueSchedules(db, [cron()], new Date(2026, 0, 20, 12, 0))).toEqual(["tidy"]);
    expect(count(db)).toBe(1);
  });

  it.each(["queued", "in_progress"])("skips the slot but advances while an item is %s", (state) => {
    fireDueSchedules(db, [cron()], new Date(2026, 0, 5, 10, 0));
    const item = addWorkItem(db, { title: "earlier", kind: "tidy" });
    db.prepare("UPDATE work_items SET status = ? WHERE id = ?").run(state, item.id);
    const now = new Date(2026, 0, 6, 4, 0);
    expect(fireDueSchedules(db, [cron()], now)).toEqual([]);
    expect(count(db)).toBe(1);
    expect(lastChecked(db)).toBe(now.toISOString());
  });

  it("fires once when called twice with the same now", () => {
    fireDueSchedules(db, [cron()], new Date(2026, 0, 5, 10, 0));
    const now = new Date(2026, 0, 6, 3, 17);
    expect(fireDueSchedules(db, [cron()], now)).toEqual(["tidy"]);
    db.prepare("UPDATE work_items SET status = 'done'").run();
    expect(fireDueSchedules(db, [cron()], now)).toEqual([]);
    expect(count(db)).toBe(1);
  });

  it("ignores queue workflows", () => {
    const queue: Workflow = { ...cron(), trigger: { type: "queue", kind: "item" } };
    expect(fireDueSchedules(db, [queue], new Date(2026, 0, 5, 10, 0))).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schedules").get()).toEqual({ n: 0 });
    expect(count(db)).toBe(0);
  });
});
