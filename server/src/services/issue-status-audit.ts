import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueStatusAudit, type IssueStatusAudit } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Service helpers for `issue_status_audit` — the table that records every
 * PATCH/checkout status-mutation attempt (success or rejected).
 *
 * The writer is **fail-soft**: it MUST never throw. PATCH-handler rollback
 * safety depends on audit-insert failures being swallowed (logged warn) so a
 * broken audit pipeline can never 500 the real mutation.
 *
 * Retention: 90 days, swept in-process every 24h (`startIssueStatusAuditRetention`).
 * Sigge confirmed in-process `setInterval` (ANT-958 Q2) — same pattern as
 * `plugin-log-retention`. Idempotent DELETE → safe across restarts.
 */

/** Default retention window. Loaded into `pruneIssueStatusAudit` callers. */
export const ISSUE_STATUS_AUDIT_RETENTION_DAYS = 90;

/** Sweep cadence for `startIssueStatusAuditRetention`. */
export const ISSUE_STATUS_AUDIT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Maximum bytes (utf8) for the `error_message` column. Caller truncates. */
const ERROR_MESSAGE_MAX_BYTES = 1024;
const DELETE_BATCH_SIZE = 5_000;
const MAX_ITERATIONS = 100;

export type AuditOutcome = "ok" | "conflict_409" | "validation_error" | "other_error";

export interface IssueStatusAuditInput {
  issueId: string;
  actorAgentId: string | null;
  actorRunId: string | null;
  /** Snapshot of issues.checkout_run_id taken BEFORE the mutation attempt. */
  checkoutRunId: string | null;
  /** Snapshot of issues.execution_run_id taken BEFORE the mutation attempt. */
  executionRunId: string | null;
  beforeStatus: string;
  /** Status the caller asked for (success) or attempted (rejected). */
  afterStatus: string;
  outcome: AuditOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** Truncate a string to `<= max` utf-8 bytes, suffixing `[truncated]`. */
export function truncateAuditMessage(value: string, max: number = ERROR_MESSAGE_MAX_BYTES): string {
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  const suffix = "[truncated]";
  const budget = Math.max(0, max - suffix.length);
  return Buffer.from(value, "utf8").subarray(0, budget).toString("utf8") + suffix;
}

/**
 * Fail-soft writer. Never throws — logs a warning and returns when the
 * underlying insert fails. This is a hard requirement from Sigges spec
 * (ANT-805 §1): audit-pipeline failure MUST NOT propagate into the real
 * PATCH/checkout response.
 */
export async function writeIssueStatusAudit(
  db: Db,
  input: IssueStatusAuditInput,
): Promise<void> {
  try {
    await db.insert(issueStatusAudit).values({
      issueId: input.issueId,
      actorAgentId: input.actorAgentId,
      actorRunId: input.actorRunId,
      checkoutRunId: input.checkoutRunId,
      executionRunId: input.executionRunId,
      beforeStatus: input.beforeStatus,
      afterStatus: input.afterStatus,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ? truncateAuditMessage(input.errorMessage) : null,
    });
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId, outcome: input.outcome, actorRunId: input.actorRunId },
      "failed to write issue_status_audit",
    );
  }
}

/**
 * Latest audit row for a given run on a given issue.
 * Used by `refreshIssueContinuationSummary` to render the server-of-record
 * Status line in continuation-summary markdown.
 */
export async function getLatestAuditForRun(
  db: Db,
  issueId: string,
  runId: string,
): Promise<IssueStatusAudit | null> {
  const rows = await db
    .select()
    .from(issueStatusAudit)
    .where(and(eq(issueStatusAudit.issueId, issueId), eq(issueStatusAudit.actorRunId, runId)))
    .orderBy(desc(issueStatusAudit.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Delete audit rows older than `retentionDays`. Batched (`DELETE_BATCH_SIZE`)
 * to bound transaction sizes; loops until a sweep deletes fewer than
 * `DELETE_BATCH_SIZE` rows or the iteration limit is reached.
 *
 * Each iteration is wrapped so a single failing batch logs a warning instead
 * of dropping the surrounding interval.
 */
export async function pruneIssueStatusAudit(
  db: Db,
  retentionDays: number = ISSUE_STATUS_AUDIT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  let totalDeleted = 0;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    let deletedThisBatch = 0;
    try {
      deletedThisBatch = await db
        .delete(issueStatusAudit)
        .where(lt(issueStatusAudit.createdAt, cutoff))
        .returning({ id: issueStatusAudit.id })
        .then((rows) => rows.length);
    } catch (err) {
      logger.warn({ err, iterations, totalDeleted }, "issue_status_audit retention batch failed");
      break;
    }

    totalDeleted += deletedThisBatch;
    iterations++;

    if (deletedThisBatch < DELETE_BATCH_SIZE) break;
  }

  if (iterations >= MAX_ITERATIONS) {
    logger.warn(
      { totalDeleted, iterations, cutoffDate: cutoff },
      "issue_status_audit retention hit iteration limit; some rows may remain",
    );
  }

  if (totalDeleted > 0) {
    logger.info({ totalDeleted, retentionDays }, "Pruned issue_status_audit");
  }

  return totalDeleted;
}

/**
 * Start the in-process retention sweep. Returns a stop function.
 *
 * Mirrors `startPluginLogRetention`: runs once immediately on boot, then on
 * every `intervalMs` tick. Per-tick errors are logged via the sweep itself
 * (see `pruneIssueStatusAudit` per-batch try/catch) and via the outer catch
 * here, so a single bad sweep cannot kill the interval.
 *
 * Defaults: 24h cadence, 90 day retention.
 */
export function startIssueStatusAuditRetention(
  db: Db,
  intervalMs: number = ISSUE_STATUS_AUDIT_SWEEP_INTERVAL_MS,
  retentionDays: number = ISSUE_STATUS_AUDIT_RETENTION_DAYS,
): () => void {
  const timer = setInterval(() => {
    pruneIssueStatusAudit(db, retentionDays).catch((err) => {
      logger.warn({ err }, "issue_status_audit retention sweep failed");
    });
  }, intervalMs);

  pruneIssueStatusAudit(db, retentionDays).catch((err) => {
    logger.warn({ err }, "initial issue_status_audit retention sweep failed");
  });

  return () => clearInterval(timer);
}
