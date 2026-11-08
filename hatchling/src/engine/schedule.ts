import type { DatabaseSync } from "node:sqlite";
import { nextRun, parseCron } from "./cron.ts";
import { addWorkItem, inTransaction } from "./store.ts";
import { type Workflow, workflowKind } from "./workflows/schema.ts";

// Adds a work item for each cron workflow whose slot has come since it was last checked. Returns the ids that fired.
// Each workflow is handled in one transaction, so two callers cannot both fire the same slot.
export function fireDueSchedules(db: DatabaseSync, workflows: Workflow[], now: Date): string[] {
  const fired: string[] = [];
  for (const workflow of workflows) {
    if (workflow.trigger.type !== "cron") continue;
    const schedule = workflow.trigger.schedule;
    const didFire = inTransaction(db, () => {
      const row = db.prepare("SELECT last_checked_at FROM schedules WHERE workflow_id = ?").get(workflow.id) as
        | { last_checked_at: string }
        | undefined;
      if (!row) {
        db.prepare("INSERT INTO schedules (workflow_id, last_checked_at) VALUES (?, ?)").run(
          workflow.id,
          now.toISOString(),
        );
        return false;
      }
      const due = nextRun(parseCron(schedule), new Date(row.last_checked_at));
      if (due === null || due.getTime() > now.getTime()) return false;
      db.prepare("UPDATE schedules SET last_checked_at = ? WHERE workflow_id = ?").run(now.toISOString(), workflow.id);
      const kind = workflowKind(workflow);
      const open = db
        .prepare("SELECT 1 FROM work_items WHERE kind = ? AND status IN ('queued', 'in_progress') LIMIT 1")
        .get(kind);
      if (open) return false;
      addWorkItem(db, { title: workflow.name, kind });
      return true;
    });
    if (didFire) fired.push(workflow.id);
  }
  return fired;
}
