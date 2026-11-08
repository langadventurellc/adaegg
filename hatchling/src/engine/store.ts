import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type Status = "queued" | "in_progress" | "done" | "failed" | "cancelled";

export type WorkItem = {
  id: string;
  title: string;
  contents: string;
  kind: string;
  status: Status;
  priority: number;
  parentId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type ListedWorkItem = WorkItem & { blockedBy: string[] };

export type NewWorkItem = {
  title: string;
  contents?: string;
  kind?: string;
  priority?: number;
  parentId?: string;
  blockedBy?: string[];
};

type Row = Record<string, unknown>;

function toItem(row: Row): WorkItem {
  return {
    id: row.id as string,
    title: row.title as string,
    contents: row.contents as string,
    kind: row.kind as string,
    status: row.status as Status,
    priority: row.priority as number,
    parentId: (row.parent_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

// Joins the caller's transaction when there is one, so a larger change commits or rolls back as a whole.
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getWorkItem(db: DatabaseSync, idOrPrefix: string): WorkItem {
  const exact = db.prepare("SELECT * FROM work_items WHERE id = ?").get(idOrPrefix);
  if (exact) return toItem(exact);
  if (idOrPrefix.length < 4) {
    throw new Error(`id prefix too short: ${idOrPrefix} (need at least 4 characters)`);
  }
  const escaped = idOrPrefix.replace(/[\\%_]/g, "\\$&");
  const rows = db
    .prepare("SELECT * FROM work_items WHERE id LIKE ? ESCAPE '\\' ORDER BY rowid LIMIT 3")
    .all(`${escaped}%`);
  if (rows.length === 0) throw new Error(`no work item matches ${idOrPrefix}`);
  if (rows.length > 1) {
    const ids = rows.map((r) => (r.id as string).slice(0, 8)).join(", ");
    throw new Error(`ambiguous id prefix ${idOrPrefix}: matches ${ids}`);
  }
  return toItem(rows[0] as Row);
}

export function addWorkItem(db: DatabaseSync, input: NewWorkItem): WorkItem {
  return inTransaction(db, () => {
    const id = randomUUID();
    const parentId = input.parentId === undefined ? null : getWorkItem(db, input.parentId).id;
    const blockers = new Set<string>();
    for (const ref of input.blockedBy ?? []) {
      let blocker: WorkItem;
      try {
        blocker = getWorkItem(db, ref);
      } catch (err) {
        // Keep the too-short and ambiguous explanations; only a miss becomes a self-block or "not found".
        if (err instanceof Error && err.message.startsWith("no work item matches")) {
          // The new item isn't stored yet, so a reference that only it matches is a self-block.
          if (ref === id || (ref.length >= 4 && id.startsWith(ref))) {
            throw new Error(`work item cannot block itself: ${ref}`);
          }
          throw new Error(`blocker not found: ${ref}`);
        }
        throw err;
      }
      blockers.add(blocker.id);
    }
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO work_items (id, title, contents, kind, priority, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.title, input.contents ?? "", input.kind ?? "item", input.priority ?? 0, parentId, now, now);
    const insertBlock = db.prepare("INSERT INTO work_item_blocks (item_id, blocked_by_id) VALUES (?, ?)");
    for (const blockerId of blockers) insertBlock.run(id, blockerId);
    return getWorkItem(db, id);
  });
}

export function listWorkItems(db: DatabaseSync, filter: { status?: Status } = {}): ListedWorkItem[] {
  const rows =
    filter.status === undefined
      ? db.prepare("SELECT * FROM work_items ORDER BY created_at, rowid").all()
      : db.prepare("SELECT * FROM work_items WHERE status = ? ORDER BY created_at, rowid").all(filter.status);
  const blockerRows = db
    .prepare(
      `SELECT b.item_id AS item_id, b.blocked_by_id AS blocker_id
       FROM work_item_blocks b JOIN work_items p ON p.id = b.blocked_by_id
       WHERE p.status != 'done' ORDER BY b.rowid`,
    )
    .all();
  const blockedBy = new Map<string, string[]>();
  for (const r of blockerRows) {
    const list = blockedBy.get(r.item_id as string) ?? [];
    list.push(r.blocker_id as string);
    blockedBy.set(r.item_id as string, list);
  }
  return rows.map((r) => ({ ...toItem(r), blockedBy: blockedBy.get(r.id as string) ?? [] }));
}

export function claimNext(db: DatabaseSync, kind: string): WorkItem | null {
  return inTransaction(db, () => {
    const row = db
      .prepare(
        `SELECT w.id FROM work_items w
         WHERE w.status = 'queued' AND w.kind = ?
           AND NOT EXISTS (
             SELECT 1 FROM work_item_blocks b JOIN work_items p ON p.id = b.blocked_by_id
             WHERE b.item_id = w.id AND p.status != 'done')
         ORDER BY w.priority DESC, w.created_at ASC, w.rowid ASC
         LIMIT 1`,
      )
      .get(kind);
    if (!row) return null;
    db.prepare("UPDATE work_items SET status = 'in_progress', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      row.id as string,
    );
    return getWorkItem(db, row.id as string);
  });
}

function transition(
  db: DatabaseSync,
  idOrPrefix: string,
  verb: string,
  allowed: Status[],
  rule: string,
  to: Status,
  extra: { error?: string | null; finished: boolean },
): WorkItem {
  return inTransaction(db, () => {
    const item = getWorkItem(db, idOrPrefix);
    if (!allowed.includes(item.status)) {
      throw new Error(`cannot ${verb} ${item.id.slice(0, 8)}: status is ${item.status} (${rule})`);
    }
    const now = new Date().toISOString();
    const error = extra.error === undefined ? item.error : extra.error;
    db.prepare("UPDATE work_items SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(
      to,
      error,
      extra.finished ? now : null,
      now,
      item.id,
    );
    return getWorkItem(db, item.id);
  });
}

export function finishWorkItem(db: DatabaseSync, id: string): WorkItem {
  return transition(db, id, "finish", ["in_progress"], "only in_progress items can be finished", "done", {
    finished: true,
  });
}

export function failWorkItem(db: DatabaseSync, id: string, error: string): WorkItem {
  return transition(db, id, "fail", ["in_progress"], "only in_progress items can be failed", "failed", {
    error,
    finished: true,
  });
}

// The one done -> failed transition: a merged item whose merge was reverted.
export function markReverted(db: DatabaseSync, id: string, error: string): WorkItem {
  return transition(db, id, "mark reverted", ["done"], "only done items can be marked reverted", "failed", {
    error,
    finished: true,
  });
}

export function cancelWorkItem(db: DatabaseSync, id: string): WorkItem {
  return transition(db, id, "cancel", ["queued"], "only queued items can be cancelled", "cancelled", {
    finished: true,
  });
}

export function retryWorkItem(db: DatabaseSync, id: string): WorkItem {
  return transition(
    db,
    id,
    "retry",
    ["failed", "cancelled"],
    "only failed or cancelled items can be retried",
    "queued",
    { error: null, finished: false },
  );
}
