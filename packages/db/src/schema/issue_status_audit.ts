import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Audit log for every status-mutation attempt on an issue.
 *
 * Written by the PATCH `/api/issues/:id` and POST `/api/issues/:id/checkout`
 * handlers. Includes BOTH successful mutations and rejected attempts (e.g.
 * `conflict_409`) so post-hoc analysis can prove what each run actually tried
 * to do, independent of any LLM-generated continuation-summary text.
 *
 * `checkout_run_id` and `execution_run_id` are stored as plain `uuid` snapshots
 * (no FK) so the audit row survives future cleanup of `heartbeat_runs`.
 *
 * Outcome is constrained to {`ok`, `conflict_409`, `validation_error`,
 * `other_error`} via a PG CHECK constraint added manually in the migration
 * SQL (Drizzle has no native CHECK helper).
 *
 * Retention: 90 days (see `services/issue-status-audit.ts`).
 */
export const issueStatusAudit = pgTable(
  "issue_status_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    actorRunId: uuid("actor_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    // snapshot, no FK (target may be cleaned up later)
    checkoutRunId: uuid("checkout_run_id"),
    executionRunId: uuid("execution_run_id"),
    beforeStatus: text("before_status").notNull(),
    afterStatus: text("after_status").notNull(),
    // 'ok' | 'conflict_409' | 'validation_error' | 'other_error' — CHECK in SQL
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    // Caller truncates to <= 1 KiB before insert.
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueCreatedIdx: index("issue_status_audit_issue_created_idx").on(table.issueId, table.createdAt),
    actorRunIdx: index("issue_status_audit_actor_run_idx").on(table.actorRunId),
    createdAtIdx: index("issue_status_audit_created_at_idx").on(table.createdAt),
  }),
);

export type IssueStatusAudit = typeof issueStatusAudit.$inferSelect;
export type IssueStatusAuditInsert = typeof issueStatusAudit.$inferInsert;
