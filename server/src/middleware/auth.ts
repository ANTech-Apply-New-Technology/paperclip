import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Structured reason codes for why a bearer token failed to resolve to an
 * authenticated actor. ANT-1202: the ANT-1201 auth 401 flap left ZERO
 * diagnostic signal because every rejection path fell through to next()
 * silently, so the downstream guard emitted a bare "Agent authentication
 * required" with no reason. These codes let us tell an intermittent store
 * failure (`db_lookup_error`) apart from a genuinely bad/unknown/revoked key.
 */
export type AuthRejectReason =
  | "no_bearer"
  | "empty_token"
  | "board_key_no_access"
  | "unknown_agent_key"
  | "agent_key_agent_missing"
  | "agent_key_agent_terminated"
  | "jwt_invalid"
  | "jwt_agent_missing"
  | "jwt_agent_company_mismatch"
  | "jwt_agent_terminated"
  | "session_resolve_error"
  | "db_lookup_error";

/**
 * Emit a single structured line describing why a token was rejected. Never
 * logs the raw token; only a short sha256 prefix so operators can correlate
 * across requests without leaking credentials. Uses `warn` for failures that
 * are operationally interesting (store errors / session resolution failures)
 * and `debug` for expected negatives (unknown/anonymous callers).
 */
function logAuthReject(
  req: Request,
  reason: AuthRejectReason,
  token?: string,
  extra?: Record<string, unknown>,
) {
  const level: "warn" | "debug" =
    reason === "db_lookup_error" || reason === "session_resolve_error" ? "warn" : "debug";
  logger[level](
    {
      authReject: reason,
      method: req.method,
      url: req.originalUrl,
      tokenHashPrefix: token ? hashToken(token).slice(0, 12) : undefined,
      ...extra,
    },
    `auth reject: ${reason}`,
  );
}

/**
 * ANT-1204: Retry-After (seconds) advertised to agent clients when auth cannot
 * be resolved because of a transient store failure (`db_lookup_error`). This is
 * a *behaviour change* from the ANT-1202 observability-only work: a transient DB
 * timeout during actor resolution used to degrade silently to an unauthenticated
 * actor, producing a misleading downstream 401 ("Agent authentication required")
 * that implies bad credentials. A valid client with a valid key must not be told
 * its credentials are wrong when the real cause is a server-side DB blip, so we
 * respond 503 + Retry-After to correctly signal "try again shortly".
 *
 * Backoff contract for agent clients:
 * - 503 + `Retry-After: 2` means: retry the SAME request after ~2s (transient).
 * - Clients SHOULD apply their own jittered exponential backoff on repeated 503s
 *   (e.g. 2s, 4s, 8s ... capped) rather than hammering at a fixed 2s.
 * - A 503 explicitly does NOT invalidate the credential; do not re-auth / rotate
 *   keys on a 503 the way a client might reasonably react to a 401.
 *
 * Impact on existing clients that today retry on 401: previously a DB blip
 * surfaced as 401, so any client that retried on 401 already recovered (by
 * accident). Those clients will now see 503 for the same underlying condition.
 * Clients that retry on 401 but NOT on 503 must be updated to honour 503 +
 * Retry-After; clients that already treat 5xx as retryable improve immediately
 * (they stop conflating transient outages with credential failures).
 */
const DB_LOOKUP_ERROR_RETRY_AFTER_SECONDS = 2;

/**
 * ANT-1204: Respond 503 + Retry-After for a transient actor-resolution store
 * failure instead of silently falling through to an unauthenticated actor.
 */
function respondDbLookupUnavailable(res: Response): void {
  res.setHeader("Retry-After", String(DB_LOOKUP_ERROR_RETRY_AFTER_SECONDS));
  res.status(503).json({
    error: "auth_store_unavailable",
    message:
      "Authentication temporarily unavailable due to a transient store error. Retry after the interval in the Retry-After header.",
    retryAfterSeconds: DB_LOOKUP_ERROR_RETRY_AFTER_SECONDS,
  });
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? {
            type: "board",
            userId: "local-board",
            userName: "Local Board",
            userEmail: null,
            isInstanceAdmin: true,
            source: "local_implicit",
          }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-paperclip-run-id");

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        const cloudTenantActor = await resolveCloudTenantActor(db, req);
        if (cloudTenantActor) {
          req.actor = {
            ...cloudTenantActor,
            runId: runIdHeader ?? undefined,
          };
          next();
          return;
        }

        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logAuthReject(req, "session_resolve_error", undefined, { err });
        }
        if (session?.user?.id) {
          const userId = session.user.id;
          const [roleRow, memberships] = await Promise.all([
            db
              .select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
              .then((rows) => rows[0] ?? null),
            db
              .select({
                companyId: companyMemberships.companyId,
                membershipRole: companyMemberships.membershipRole,
                status: companyMemberships.status,
              })
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.principalId, userId),
                  eq(companyMemberships.status, "active"),
                ),
              ),
          ]);
          req.actor = {
            type: "board",
            userId,
            userName: session.user.name ?? null,
            userEmail: session.user.email ?? null,
            companyIds: memberships.map((row) => row.companyId),
            memberships,
            isInstanceAdmin: Boolean(roleRow),
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          next();
          return;
        }
      }
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      logAuthReject(req, "empty_token");
      next();
      return;
    }

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          userName: access.user?.name ?? null,
          userEmail: access.user?.email ?? null,
          companyIds: access.companyIds,
          memberships: access.memberships,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKey.id,
          runId: runIdHeader || undefined,
          source: "board_key",
        };
        next();
        return;
      }
      logAuthReject(req, "board_key_no_access", token, { boardKeyId: boardKey.id });
    }

    const tokenHash = hashToken(token);
    let key: typeof agentApiKeys.$inferSelect | null;
    try {
      key = await db
        .select()
        .from(agentApiKeys)
        .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
        .then((rows) => rows[0] ?? null);
    } catch (err) {
      // Intermittent store failure (timeout / connection reset). Before ANT-1202
      // this silently fell through to an anonymous actor -> downstream bare 401
      // with no signal. Now we log the real reason. Behaviour is otherwise
      // unchanged (still treated as unauthenticated for this request).
      // ANT-1204: transient store failure resolving the agent key. Behaviour
      // change from ANT-1202 (which only logged then degraded to anonymous):
      // respond 503 + Retry-After so a valid client is told to retry rather than
      // seeing a misleading 401.
      logAuthReject(req, "db_lookup_error", token, { stage: "agent_api_key_lookup", err });
      respondDbLookupUnavailable(res);
      return;
    }

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        logAuthReject(req, "unknown_agent_key", token);
        next();
        return;
      }

      let agentRecord: typeof agents.$inferSelect | null;
      try {
        agentRecord = await db
          .select()
          .from(agents)
          .where(eq(agents.id, claims.sub))
          .then((rows) => rows[0] ?? null);
      } catch (err) {
        // ANT-1204: transient store failure resolving the JWT agent record.
        logAuthReject(req, "db_lookup_error", token, { stage: "jwt_agent_lookup", agentId: claims.sub, err });
        respondDbLookupUnavailable(res);
        return;
      }

      if (!agentRecord) {
        logAuthReject(req, "jwt_agent_missing", token, { agentId: claims.sub });
        next();
        return;
      }
      if (agentRecord.companyId !== claims.company_id) {
        logAuthReject(req, "jwt_agent_company_mismatch", token, { agentId: claims.sub });
        next();
        return;
      }

      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        logAuthReject(req, "jwt_agent_terminated", token, { agentId: claims.sub, agentStatus: agentRecord.status });
        next();
        return;
      }

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        runId: runIdHeader || claims.run_id || undefined,
        source: "agent_jwt",
      };
      next();
      return;
    }

    try {
      await db
        .update(agentApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(agentApiKeys.id, key.id));
    } catch (err) {
      // Best-effort last-used bookkeeping must never fail an otherwise valid
      // key. Log and continue so a transient write hiccup does not manifest as
      // a spurious 401.
      logAuthReject(req, "db_lookup_error", token, { stage: "agent_api_key_touch", keyId: key.id, err });
    }

    let agentRecord: typeof agents.$inferSelect | null;
    try {
      agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, key.agentId))
        .then((rows) => rows[0] ?? null);
    } catch (err) {
      // ANT-1204: transient store failure resolving the agent record behind a
      // valid key.
      logAuthReject(req, "db_lookup_error", token, { stage: "agent_key_agent_lookup", agentId: key.agentId, err });
      respondDbLookupUnavailable(res);
      return;
    }

    if (!agentRecord) {
      logAuthReject(req, "agent_key_agent_missing", token, { agentId: key.agentId });
      next();
      return;
    }
    if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      logAuthReject(req, "agent_key_agent_terminated", token, { agentId: key.agentId, agentStatus: agentRecord.status });
      next();
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    next();
  };
}

async function resolveCloudTenantActor(db: Db, req: Request): Promise<Express.Request["actor"] | null> {
  const expectedToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim();
  if (!expectedToken) return null;

  const token = req.header("x-paperclip-cloud-tenant-token")?.trim();
  if (!token || !constantTimeStringEqual(token, expectedToken)) return null;

  const userId = requiredCloudHeader(req, "x-paperclip-cloud-user-id");
  const userEmail = requiredCloudHeader(req, "x-paperclip-cloud-user-email").toLowerCase();
  const stackId = requiredCloudHeader(req, "x-paperclip-cloud-stack-id");
  const stackRole = stackMembershipRole(req.header("x-paperclip-cloud-stack-role"));
  const userName = req.header("x-paperclip-cloud-user-name")?.trim() || userEmail;
  const paperclipCompanyId = req.header("x-paperclip-cloud-paperclip-company-id")?.trim();
  const companyId = cloudTenantCompanyId(stackId);
  const companyName = paperclipCompanyId || `${stackId} Paperclip`;
  const now = new Date();

  await db
    .insert(authUsers)
    .values({
      id: userId,
      name: userName,
      email: userEmail,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authUsers.id,
      set: {
        name: userName,
        email: userEmail,
        emailVerified: true,
        updatedAt: now,
      },
    });

  await db
    .insert(instanceUserRoles)
    .values({
      userId,
      role: "instance_admin",
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [instanceUserRoles.userId, instanceUserRoles.role],
    });

  await db
    .insert(companies)
    .values({
      id: companyId,
      name: companyName,
      description: `Provisioned by Paperclip Cloud for stack ${stackId}.`,
      status: "active",
      issuePrefix: issuePrefixForCloudStack(stackId),
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: companies.id,
    });

  const membershipRole = stackRole === "owner" || stackRole === "admin" ? "owner" : stackRole;
  const membership = await db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        companyMemberships.companyId,
        companyMemberships.principalType,
        companyMemberships.principalId,
      ],
      set: {
        status: "active",
        membershipRole,
        updatedAt: now,
      },
    })
    .returning()
    .then((rows) => rows[0] ?? {
      companyId,
      membershipRole,
      status: "active",
    });

  return {
    type: "board",
    userId,
    userName,
    userEmail,
    companyIds: [companyId],
    memberships: [{
      companyId,
      membershipRole: membership.membershipRole,
      status: membership.status,
    }],
    isInstanceAdmin: true,
    source: "cloud_tenant",
  };
}

function requiredCloudHeader(req: Request, name: string): string {
  const value = req.header(name)?.trim();
  if (!value) {
    throw new Error(`Missing trusted Cloud tenant header ${name}`);
  }
  return value;
}

function stackMembershipRole(value: string | undefined): "owner" | "admin" | "member" | "support" {
  if (value === "owner" || value === "admin" || value === "member" || value === "support") {
    return value;
  }
  throw new Error("Invalid trusted Cloud tenant stack role");
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cloudTenantCompanyId(stackId: string): string {
  const bytes = createHash("sha256").update(`paperclip-cloud-tenant-company:${stackId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function issuePrefixForCloudStack(stackId: string): string {
  const hash = createHash("sha256").update(stackId).digest("hex").slice(0, 4).toUpperCase();
  return `PC${hash}`;
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
