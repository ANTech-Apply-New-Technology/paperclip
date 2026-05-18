import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueStatusAudit,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue_status_audit PATCH tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("PATCH /api/issues/:id audit-wrapper", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-status-audit-patch-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueStatusAudit);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedScenario() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const peerAgentId = randomUUID();
    const ownerRunId = randomUUID();
    const peerRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Owner",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: peerAgentId,
        companyId,
        name: "Peer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: ownerRunId,
        companyId,
        agentId: ownerAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: peerRunId,
        companyId,
        agentId: peerAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, ownerAgentId, peerAgentId, ownerRunId, peerRunId };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  async function getLatestAudit(issueId: string) {
    const rows = await db
      .select()
      .from(issueStatusAudit)
      .where(eq(issueStatusAudit.issueId, issueId))
      .orderBy(desc(issueStatusAudit.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  it("writes an `ok` audit row on a successful PATCH", async () => {
    const { companyId, ownerAgentId, ownerRunId } = await seedScenario();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "audit ok",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      executionAgentNameKey: "owner",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, ownerAgentId, ownerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const audit = await getLatestAudit(issueId);
    expect(audit).toMatchObject({
      issueId,
      actorAgentId: ownerAgentId,
      actorRunId: ownerRunId,
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      beforeStatus: "in_progress",
      afterStatus: "done",
      outcome: "ok",
      errorCode: null,
      errorMessage: null,
    });
  });

  it("writes a `conflict_409` audit row when assertAgentIssueMutationAllowed rejects an in_progress peer", async () => {
    const { companyId, ownerAgentId, peerAgentId, ownerRunId, peerRunId } = await seedScenario();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "audit conflict",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      executionAgentNameKey: "owner",
      executionLockedAt: new Date(),
    });

    // Peer tries to mutate while owner has the lock.
    const res = await request(createApp(agentActor(companyId, peerAgentId, peerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);

    const audit = await getLatestAudit(issueId);
    expect(audit).toMatchObject({
      issueId,
      actorAgentId: peerAgentId,
      actorRunId: peerRunId,
      // Snapshot captures the OWNER's run, not the peer trying to override.
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      beforeStatus: "in_progress",
      afterStatus: "done",
      outcome: "conflict_409",
      errorCode: "ownership_conflict",
    });
    expect(audit?.errorMessage).toMatch(/checked out by another agent/i);
  });

  it("does NOT write an audit row when assertAgentIssueMutationAllowed responds with 403 (non-in_progress peer)", async () => {
    // Sigge ANT-958 Q4: only {ok, conflict_409, validation_error, other_error}
    // are persisted. 403 ("Agent cannot mutate another agent's issue") MUST NOT
    // emit an audit row.
    const { companyId, ownerAgentId, peerAgentId, peerRunId } = await seedScenario();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "audit 403 skip",
      status: "todo",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
    });

    const res = await request(createApp(agentActor(companyId, peerAgentId, peerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);

    const audit = await getLatestAudit(issueId);
    expect(audit).toBeNull();
  });

  it("writes the issue's actual post-update status (not the requested one) on a no-op PATCH", async () => {
    // Confirms `afterStatus` is read from the persisted row, not from req.body.
    const { companyId, ownerAgentId, ownerRunId } = await seedScenario();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "audit afterStatus from server",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      executionAgentNameKey: "owner",
      executionLockedAt: new Date(),
    });

    // Title-only mutation: status stays in_progress, audit afterStatus should be in_progress.
    const res = await request(createApp(agentActor(companyId, ownerAgentId, ownerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "renamed" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const audit = await getLatestAudit(issueId);
    expect(audit?.outcome).toBe("ok");
    expect(audit?.beforeStatus).toBe("in_progress");
    expect(audit?.afterStatus).toBe("in_progress");
  });

  it("PATCH still returns 200 when the audit insert itself fails (fail-soft)", async () => {
    // Drop the table so the next INSERT throws. The PATCH MUST still succeed.
    // This is the explicit acceptance criterion from ANT-960:
    //   "Audit-wrapper fail-soft verifierat (audit-insert kastar → PATCH
    //    returnerar fortfarande 200)".
    const { companyId, ownerAgentId, ownerRunId } = await seedScenario();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "audit fail-soft",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      executionAgentNameKey: "owner",
      executionLockedAt: new Date(),
    });

    // Sabotage: drop the audit table so writeIssueStatusAudit's insert throws.
    await db.execute(/*sql*/`DROP TABLE IF EXISTS "issue_status_audit" CASCADE`);

    // NOTE: we PATCH to `done` (not `in_review`) here because in_review now
    // requires a real review path (see `invalid_issue_disposition`). The
    // fail-soft contract we want to assert is "audit table is dropped → real
    // PATCH still returns 200", which is independent of the target status.
    const res = await request(createApp(agentActor(companyId, ownerAgentId, ownerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    // The real PATCH MUST still complete successfully.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");

    // Recreate the audit table for the next afterEach() cleanup. The simplest
    // path is to re-apply the migration SQL fragment in-place. We use a minimal
    // re-create matching the schema used by `db.delete(issueStatusAudit)`.
    await db.execute(/*sql*/`
      CREATE TABLE IF NOT EXISTS "issue_status_audit" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "issue_id" uuid NOT NULL,
        "actor_agent_id" uuid,
        "actor_run_id" uuid,
        "checkout_run_id" uuid,
        "execution_run_id" uuid,
        "before_status" text NOT NULL,
        "after_status" text NOT NULL,
        "outcome" text NOT NULL,
        "error_code" text,
        "error_message" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
  });
});
