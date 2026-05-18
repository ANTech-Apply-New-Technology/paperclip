import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueStatusAudit,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  pruneIssueStatusAudit,
  startIssueStatusAuditRetention,
  truncateAuditMessage,
  writeIssueStatusAudit,
} from "../services/issue-status-audit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue_status_audit retention tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue_status_audit retention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-status-audit-retention-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueStatusAudit);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Auditor",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "audit retention target",
      status: "todo",
      priority: "medium",
    });
    return { companyId, agentId, issueId };
  }

  async function insertAuditRow(
    issueId: string,
    actorAgentId: string,
    createdAt: Date,
    label: string,
  ) {
    await db.insert(issueStatusAudit).values({
      issueId,
      actorAgentId,
      actorRunId: null,
      checkoutRunId: null,
      executionRunId: null,
      beforeStatus: "todo",
      afterStatus: "in_progress",
      outcome: "ok",
      errorCode: null,
      errorMessage: label,
      createdAt,
    });
  }

  it("deletes rows older than the retention window and leaves fresh rows untouched", async () => {
    const { agentId, issueId } = await seed();
    const oldDate = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

    for (let i = 0; i < 5; i++) {
      await insertAuditRow(issueId, agentId, oldDate, `old-${i}`);
    }
    for (let i = 0; i < 3; i++) {
      await insertAuditRow(issueId, agentId, recentDate, `recent-${i}`);
    }

    const deleted = await pruneIssueStatusAudit(db, 90);
    expect(deleted).toBe(5);

    const remaining = await db.select().from(issueStatusAudit);
    expect(remaining).toHaveLength(3);
    expect(remaining.every((row) => row.errorMessage?.startsWith("recent-"))).toBe(true);
  });

  it("is idempotent: a second sweep on freshly pruned data returns 0", async () => {
    const { agentId, issueId } = await seed();
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await insertAuditRow(issueId, agentId, oldDate, "stale-1");
    await insertAuditRow(issueId, agentId, oldDate, "stale-2");

    expect(await pruneIssueStatusAudit(db, 90)).toBe(2);
    expect(await pruneIssueStatusAudit(db, 90)).toBe(0);
  });

  it("truncates oversized error_message payloads to <= 1 KiB", () => {
    const big = "x".repeat(4096);
    const out = truncateAuditMessage(big);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1024);
    expect(out.endsWith("[truncated]")).toBe(true);
  });

  it("writeIssueStatusAudit fail-soft: insert error becomes a logged warning", async () => {
    // Pass an invalid outcome to trigger the CHECK constraint — confirms
    // that a downstream insert failure does NOT throw out of the writer.
    const { issueId, agentId } = await seed();
    let resolved = false;
    await writeIssueStatusAudit(db, {
      issueId,
      actorAgentId: agentId,
      actorRunId: null,
      checkoutRunId: null,
      executionRunId: null,
      beforeStatus: "todo",
      afterStatus: "done",
      // @ts-expect-error: intentionally invalid outcome to trip the CHECK constraint
      outcome: "definitely_not_a_valid_outcome",
      errorMessage: null,
    });
    resolved = true;
    expect(resolved).toBe(true);

    // No row should have been written for the invalid outcome.
    const rows = await db.select().from(issueStatusAudit);
    expect(rows).toHaveLength(0);
  });

  it("startIssueStatusAuditRetention runs immediately and returns a stop function", async () => {
    const { agentId, issueId } = await seed();
    const oldDate = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);
    await insertAuditRow(issueId, agentId, oldDate, "scheduled-stale");

    const stop = startIssueStatusAuditRetention(db, 60 * 60 * 1000, 90);
    // Give the immediate sweep a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 250));
    stop();

    const rows = await db.select().from(issueStatusAudit);
    expect(rows).toHaveLength(0);
  });
});
