import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MIGRATIONS: string[] = [
  `CREATE TABLE work_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    contents TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'item',
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'in_progress', 'done', 'failed', 'cancelled')),
    priority INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT REFERENCES work_items(id),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE work_item_blocks (
    item_id TEXT NOT NULL REFERENCES work_items(id),
    blocked_by_id TEXT NOT NULL REFERENCES work_items(id),
    PRIMARY KEY (item_id, blocked_by_id)
  );
  CREATE INDEX work_items_claim ON work_items (status, kind, priority, created_at);`,
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id),
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    current_node TEXT,
    state TEXT NOT NULL,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE node_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    outcome TEXT,
    problem TEXT,
    cost_usd REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX runs_status ON runs (status);
  CREATE INDEX node_runs_run ON node_runs (run_id);`,
];

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = row.user_version + 1; version <= MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version - 1] as string);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
