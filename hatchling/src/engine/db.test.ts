import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS, openDb } from "./db.ts";

const dir = mkdtempSync(join(tmpdir(), "hatch-db-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function pragma(db: ReturnType<typeof openDb>, name: string): Record<string, unknown> {
  return db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
}

describe("openDb", () => {
  it("migrates once and sets the pragmas", () => {
    const path = join(dir, "nested", "hatch.db");
    const first = openDb(path);
    expect(pragma(first, "user_version").user_version).toBe(MIGRATIONS.length);
    first.prepare("INSERT INTO work_items (id, title, created_at, updated_at) VALUES ('a', 't', 'x', 'x')").run();
    first.close();

    const second = openDb(path);
    expect(pragma(second, "user_version").user_version).toBe(MIGRATIONS.length);
    expect(second.prepare("SELECT count(*) AS n FROM work_items").get()).toEqual({ n: 1 });
    expect(pragma(second, "journal_mode").journal_mode).toBe("wal");
    expect(pragma(second, "foreign_keys").foreign_keys).toBe(1);
    expect(pragma(second, "busy_timeout").timeout).toBe(5000);
    second.close();
  });

  it("applies the source_id migration on a version 2 database and keeps its rows", () => {
    const path = join(dir, "v2", "hatch.db");
    mkdirSync(dirname(path), { recursive: true });
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0] as string);
    old.exec(MIGRATIONS[1] as string);
    old.exec("PRAGMA user_version = 2");
    old.prepare("INSERT INTO work_items (id, title, created_at, updated_at) VALUES ('a', 't', 'x', 'x')").run();
    old.close();

    const db = openDb(path);
    expect(pragma(db, "user_version").user_version).toBe(MIGRATIONS.length);
    expect(db.prepare("SELECT id, source_id FROM work_items").all()).toEqual([{ id: "a", source_id: null }]);
    db.close();
  });

  it("works on :memory:", () => {
    const db = openDb(":memory:");
    expect(pragma(db, "user_version").user_version).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(4);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const names = tables.map((t) => t.name);
    expect(names).toContain("runs");
    expect(names).toContain("node_runs");
    db.close();
  });
});
