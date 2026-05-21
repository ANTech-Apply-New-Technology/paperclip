import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ANT-1076: Split comment auth from issue-mutation auth (Option 1).
// `POST /issues/:id/comments` must accept comments from any agent in the same
// company. Other mutations (status, blockedBy, plan, approval, document, etc.)
// stay restricted to the assignee. `DELETE /issues/:id/comments/:commentId`
// also keeps the strict mutation gate (Sigge: Option 1 is explicit — DELETE
// is destructive and is not relaxed).

const issueId = "44444444-4444-4444-8444-444444444444";
const companyA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agentAssignee = "11111111-1111-4111-8111-111111111111";
const agentPeerSameCompany = "22222222-2222-4222-8222-222222222222";
const agentOtherCompany = "33333333-3333-4333-8333-333333333333";
const peerRunId = "66666666-6666-4666-8666-666666666666";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
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

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
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

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({ insert: mockTxInsert }));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({ orderBy: mockDbSelectOrderBy })));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
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
  companyService: () => mockCompanyService,
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

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId: companyA,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: agentAssignee,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1076",
    title: "ANT-1076 fixture issue",
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    hiddenAt: null,
    ...overrides,
  };
}

function peerActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: agentPeerSameCompany,
    companyId: companyA,
    source: "agent_key",
    runId: peerRunId,
    ...overrides,
  };
}

function otherCompanyActor() {
  return {
    type: "agent",
    agentId: agentOtherCompany,
    companyId: companyB,
    source: "agent_key",
    runId: "77777777-7777-4777-8777-777777777777",
  };
}

function assigneeActor() {
  return {
    type: "agent",
    agentId: agentAssignee,
    companyId: companyA,
    source: "agent_key",
    runId: "55555555-5555-4555-8555-555555555555",
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue comment auth split (ANT-1076)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.addComment.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockCompanyService.getById.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueTreeControlService.getActivePauseHoldGate.mockReset();
    mockRoutineService.syncRunStatusForIssue.mockReset();
    mockLogActivity.mockReset();
    mockTxInsertValues.mockReset();
    mockTxInsert.mockReset();
    mockDbSelect.mockReset();
    mockDbSelectFrom.mockReset();
    mockDbSelectWhere.mockReset();
    mockDbSelectOrderBy.mockReset();
    mockDb.transaction.mockReset();

    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyA, issuePrefix: "PAP" });
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId,
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      issueId,
      companyId: companyA,
      body: "hi",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: agentPeerSameCompany,
      authorUserId: null,
    });
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({ orderBy: mockDbSelectOrderBy }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  });

  // ===== Case 1 =====
  it("allows non-assignee agent in same company to POST a comment", async () => {
    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hi" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    const call = mockIssueService.addComment.mock.calls[0] ?? [];
    expect(call[0]).toBe(issueId);
    expect(call[1]).toBe("hi");
    expect(call[2]).toMatchObject({ agentId: agentPeerSameCompany });
  });

  // ===== Case 2 =====
  it("rejects non-assignee agent from a different company", async () => {
    const res = await request(await createApp(otherCompanyActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hi" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // assertCompanyAccess throws; the error handler normalizes the response.
    // We just need to confirm the comment was not persisted and the error
    // surfaces (no 201).
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  // ===== Case 3 =====
  it("keeps reopen path restricted: non-assignee agent + reopen:true on done issue → 403", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "done" }));

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hi", reopen: true });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot request follow-up for another agent's issue");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // ===== Case 4 =====
  it("keeps interrupt board-only: non-assignee agent + interrupt:true → 403", async () => {
    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hi", interrupt: true });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Only board users can interrupt active runs from issue comments");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  // ===== Case 5 =====
  it("keeps structured fields board-only: non-assignee agent + presentation → 403", async () => {
    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({
        body: "hi",
        presentation: { kind: "message", tone: "neutral" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Only board users may set structured comment presentation or metadata");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  // ===== Case 6 =====
  it("assignee still works: assignee POST comment → 201 (no regression)", async () => {
    mockIssueService.addComment.mockResolvedValue({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      issueId,
      companyId: companyA,
      body: "hi",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: agentAssignee,
      authorUserId: null,
    });

    const res = await request(await createApp(assigneeActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hi" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    const call = mockIssueService.addComment.mock.calls[0] ?? [];
    expect(call[0]).toBe(issueId);
    expect(call[1]).toBe("hi");
    expect(call[2]).toMatchObject({ agentId: agentAssignee });
  });

  // ===== Case 7 =====
  it("PATCH stays locked: non-assignee agent PATCH /issues/:id status → 409 (regression guard)", async () => {
    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
