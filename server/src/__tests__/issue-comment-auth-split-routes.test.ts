import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ANT-1076 — Split comment auth from issue-mutation auth (Option 1).
//
// Plan: ANT-1078. 7-case matrix from ANT-1076 acceptance.
//
// Same-company agents (regardless of assignee) may POST comments. Status,
// blockedBy, plan/approval, and structured comment fields (presentation,
// metadata, interrupt) stay restricted exactly as before.
// ---------------------------------------------------------------------------

const issueId = "11111111-1111-4111-8111-111111111111";
const companyA = "company-1";
const companyB = "company-2";
const agentAssignee = "22222222-2222-4222-8222-222222222222";
const agentPeerSameCompany = "33333333-3333-4333-8333-333333333333";
const agentOtherCompany = "44444444-4444-4444-8444-444444444444";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({ orderBy: mockDbSelectOrderBy })));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => [companyA]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: companyA, attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(
  status: "todo" | "done" | "blocked" | "cancelled" | "in_progress" = "in_progress",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: issueId,
    companyId: companyA,
    status,
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: agentAssignee,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1076",
    title: "Comment auth split target",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function peerActor() {
  return {
    type: "agent",
    agentId: agentPeerSameCompany,
    companyId: companyA,
    source: "agent_key",
    runId: "55555555-5555-4555-8555-555555555555",
  };
}

function otherCompanyActor() {
  return {
    type: "agent",
    agentId: agentOtherCompany,
    companyId: companyB,
    source: "agent_key",
    runId: "66666666-6666-4666-8666-666666666666",
  };
}

function assigneeActor() {
  return {
    type: "agent",
    agentId: agentAssignee,
    companyId: companyA,
    source: "agent_key",
    runId: "77777777-7777-4777-8777-777777777777",
  };
}

describe.sequential("issue comment auth split (ANT-1076)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      unresolvedBlockerCount: 0,
      unresolvedBlockerIssueIds: [],
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId,
      companyId: companyA,
      body: "hi",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: agentPeerSameCompany,
      authorUserId: null,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("in_progress"),
      ...patch,
    }));
  });

  it("case 1 — allows non-assignee agent in same company to POST a comment on in_progress issue", async () => {
    const res = await request(await installActor(createApp(), peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hi" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "hi",
      expect.objectContaining({ agentId: agentPeerSameCompany }),
      expect.any(Object),
    );
    // Bare comment must not trigger status mutation.
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("case 2 — rejects non-assignee agent from a different company with 403", async () => {
    const res = await request(await installActor(createApp(), otherCompanyActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hi" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("case 3 — keeps reopen restricted: non-assignee agent + reopen:true on done issue → 403", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));

    const res = await request(await installActor(createApp(), peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hi", reopen: true });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot request follow-up for another agent's issue");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("case 4 — keeps interrupt board-only: non-assignee agent + interrupt:true → 403", async () => {
    const res = await request(await installActor(createApp(), peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hi", interrupt: true });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Only board users can interrupt active runs from issue comments");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("case 5 — keeps structured presentation board-only: non-assignee agent + presentation:{...} → 403", async () => {
    const res = await request(await installActor(createApp(), peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({
        body: "hi",
        presentation: { kind: "system_notice", tone: "warning" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe(
      "Only board users may set structured comment presentation or metadata",
    );
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("case 5b — keeps structured metadata board-only: non-assignee agent + metadata:{...} → 403", async () => {
    const res = await request(await installActor(createApp(), peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({
        body: "hi",
        metadata: {
          version: 1,
          sections: [
            {
              rows: [{ type: "text", text: "smuggled" }],
            },
          ],
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe(
      "Only board users may set structured comment presentation or metadata",
    );
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("case 6 — assignee POST comment → 201 (no regression)", async () => {
    const res = await request(await installActor(createApp(), assigneeActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hi" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "hi",
      expect.objectContaining({ agentId: agentAssignee }),
      expect.any(Object),
    );
  });

  it("case 7 — PATCH stays locked: non-assignee agent PATCH /issues/:id status → 409 on active checkout", async () => {
    const res = await request(await installActor(createApp(), peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
