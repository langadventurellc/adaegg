import type { DatabaseSync } from "node:sqlite";

export type PageDataEntry = { key: string; value: unknown; updatedAt: string };

// A page id or a key: kebab-case or a simple identifier, at most 64 characters.
export const PAGE_DATA_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isPageDataId(s: string): boolean {
  return PAGE_DATA_ID.test(s);
}

function toEntry(row: Record<string, unknown>): PageDataEntry {
  return { key: row.key as string, value: JSON.parse(row.value as string), updatedAt: row.updated_at as string };
}

export function getPageData(db: DatabaseSync, page: string, key: string): PageDataEntry | null {
  const row = db.prepare("SELECT key, value, updated_at FROM page_data WHERE page = ? AND key = ?").get(page, key);
  return row ? toEntry(row) : null;
}

export function listPageData(db: DatabaseSync, page: string): PageDataEntry[] {
  return db.prepare("SELECT key, value, updated_at FROM page_data WHERE page = ? ORDER BY key").all(page).map(toEntry);
}

export function setPageData(db: DatabaseSync, page: string, key: string, value: unknown): PageDataEntry {
  const updatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO page_data (page, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(page, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(page, key, JSON.stringify(value), updatedAt);
  return { key, value, updatedAt };
}

export function deletePageData(db: DatabaseSync, page: string, key: string): boolean {
  return Number(db.prepare("DELETE FROM page_data WHERE page = ? AND key = ?").run(page, key).changes) > 0;
}
