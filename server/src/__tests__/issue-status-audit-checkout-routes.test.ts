import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { desc, eq } from "drizzle-orm";
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
    `Skipping embedded Postgres issue_status_audit checkout tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("POST /api/issues/:id/checkout audit-wrapper + 15-min lock", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-status-audit-checkout-");
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

  async function seed() {
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

  it("writes an `ok` audit row on a fresh checkout (no prior lock)", async () => {
    const { companyId, ownerAgentId, ownerRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "fresh checkout",
      status: "todo",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
    });

    const res = await request(createApp(agentActor(companyId, ownerAgentId, ownerRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .set("X-Paperclip-Run-Id", ownerRunId)
      .send({ agentId: ownerAgentId, expectedStatuses: ["todo"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        executionAgentId: issues.executionAgentId,
        executionLockedAt: issues.executionLockedAt,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("in_progress");
    expect(row?.executionAgentId).toBe(ownerAgentId);
    expect(row?.executionRunId).toBe(ownerRunId);
    expect(row?.executionLockedAt).not.toBeNull();

    const audit = await getLatestAudit(issueId);
    expect(audit).toMatchObject({
      issueId,
      actorAgentId: ownerAgentId,
      actorRunId: ownerRunId,
      beforeStatus: "todo",
      afterStatus: "in_progress",
      outcome: "ok",
    });
    // Fresh take: no handoff message.
    expect(audit?.errorMessage).toBeNull();
  });

  it("hands off a stale lock (>=15 min) and tags the audit row with the previous run", async () => {
    const { companyId, ownerAgentId, peerAgentId, ownerRunId, peerRunId } = await seed();
    const issueId = randomUUID();
    const sixteenMinAgo = new Date(Date.now() - 16 * 60 * 1000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "stale lock handoff",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      executionAgentId: ownerAgentId,
      executionAgentNameKey: "owner",
      executionLockedAt: sixteenMinAgo,
    });

    const res = await request(createApp(agentActor(companyId, peerAgentId, peerRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .set("X-Paperclip-Run-Id", peerRunId)
      .send({ agentId: peerAgentId, expectedStatuses: ["todo", "in_progress"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const audit = await getLatestAudit(issueId);
    expect(audit?.outcome).toBe("ok");
    expect(audit?.actorAgentId).toBe(peerAgentId);
    expect(audit?.actorRunId).toBe(peerRunId);
    // Snapshot captured the PRE-checkout state.
    expect(audit?.executionRunId).toBe(ownerRunId);
    expect(audit?.errorMessage).toMatch(new RegExp(`stale_lock_handoff prev_run=${ownerRunId}`));
  });

  it("rejects forceRelease=true when the actor IS the current lock owner", async () => {
    const { companyId, ownerAgentId, ownerRunId, peerRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "self-force-release",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      executionAgentId: ownerAgentId,
      executionAgentNameKey: "owner",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, ownerAgentId, peerRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .set("X-Paperclip-Run-Id", peerRunId)
      .send({ agentId: ownerAgentId, expectedStatuses: ["in_progress"], forceRelease: true });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toMatch(/cannot break.*own lock/i);
  });

  it("rejects forceRelease=true from an agent without manage_active_checkouts override", async () => {
    const { companyId, ownerAgentId, peerAgentId, ownerRunId, peerRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "peer cannot force-release",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      executionAgentId: ownerAgentId,
      executionAgentNameKey: "owner",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, peerAgentId, peerRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .set("X-Paperclip-Run-Id", peerRunId)
      .send({ agentId: peerAgentId, expectedStatuses: ["in_progress"], forceRelease: true });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toMatch(/manage_active_checkouts/);
  });

  it("writes a conflict_409 audit row when a fresh peer checkout collides with a live lock (<15 min)", async () => {
    const { companyId, ownerAgentId, peerAgentId, ownerRunId, peerRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "live lock conflict",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      executionAgentId: ownerAgentId,
      executionAgentNameKey: "owner",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, peerAgentId, peerRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .set("X-Paperclip-Run-Id", peerRunId)
      .send({ agentId: peerAgentId, expectedStatuses: ["todo", "in_progress"] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);

    const audit = await getLatestAudit(issueId);
    expect(audit).toMatchObject({
      issueId,
      actorAgentId: peerAgentId,
      actorRunId: peerRunId,
      outcome: "conflict_409",
      errorCode: "checkout_conflict",
    });
  });
});
