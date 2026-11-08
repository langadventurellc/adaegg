import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("works on :memory:", () => {
    const db = openDb(":memory:");
    expect(pragma(db, "user_version").user_version).toBe(MIGRATIONS.length);
    db.close();
  });
});
