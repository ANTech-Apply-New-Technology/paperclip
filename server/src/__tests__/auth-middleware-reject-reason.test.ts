import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ANT-1202: The ANT-1201 auth 401 flap left ZERO diagnostic signal because
 * every rejection path in `actorMiddleware` fell through to `next()` silently,
 * so the downstream guard emitted a bare "Agent authentication required" with
 * no reason. These tests pin the structured reject-reason logging, most
 * importantly that an intermittent store failure is surfaced as
 * `db_lookup_error` (the exact signal missing during the outage) instead of
 * being indistinguishable from an unknown/anonymous caller.
 *
 * ANT-1204: Behaviour change on top of the ANT-1202 observability work. A
 * transient store failure while resolving the actor (`db_lookup_error` in the
 * `agent_api_key_lookup`, `jwt_agent_lookup`, and `agent_key_agent_lookup`
 * branches) no longer degrades silently to an unauthenticated actor -> bare
 * downstream 401. Instead the middleware responds `503 + Retry-After`, so a
 * valid client with a valid key is correctly told to retry rather than being
 * misled into thinking its credentials are wrong. The best-effort
 * `lastUsedAt` touch (`agent_api_key_touch`) MUST remain non-fatal.
 */

// Capture structured logger calls.
const logCalls: Array<{ level: "warn" | "debug"; obj: Record<string, unknown>; msg: string }> = [];
vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: (obj: Record<string, unknown>, msg: string) => logCalls.push({ level: "warn", obj, msg }),
    debug: (obj: Record<string, unknown>, msg: string) => logCalls.push({ level: "debug", obj, msg }),
    info: () => {},
    error: () => {},
  },
}));

// Board auth never resolves a board key in these tests.
vi.mock("../services/board-auth.js", () => ({
  boardAuthService: () => ({
    findBoardApiKeyByToken: async () => null,
    resolveBoardAccess: async () => ({ user: null }),
    touchBoardApiKey: async () => {},
  }),
}));

// JWT verification behaviour is switched per-test.
let jwtClaims: { sub: string; company_id: string; run_id?: string } | null = null;
vi.mock("../agent-auth-jwt.js", () => ({
  verifyLocalAgentJwt: () => jwtClaims,
}));

import { actorMiddleware } from "../middleware/auth.js";
import type { Db } from "@paperclipai/db";

function makeReq(token: string): Request {
  return {
    method: "GET",
    originalUrl: "/api/agents/me",
    header(name: string) {
      const n = name.toLowerCase();
      if (n === "authorization") return `Bearer ${token}`;
      return undefined;
    },
    actor: undefined,
  } as unknown as Request;
}

interface FakeRes {
  statusCode: number | null;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  setHeader(name: string, value: string): void;
}

function makeRes(): FakeRes & Response {
  const res: FakeRes = {
    statusCode: null,
    body: undefined,
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
    },
  };
  return res as unknown as FakeRes & Response;
}

type SelectBehavior = "empty" | "ok" | "throw";

/**
 * Minimal drizzle-like fake. Each `select()` chain resolves according to the
 * next entry in `behaviors` (so consecutive lookups can differ, e.g. the key
 * lookup succeeds but the agent lookup throws). `update().set().where()`
 * behaviour is controlled by `updateThrows` to simulate a transient write
 * failure in the non-fatal `lastUsedAt` touch.
 */
function makeDb(opts: {
  selects: SelectBehavior[];
  selectRows?: unknown[][];
  updateThrows?: boolean;
}): Db {
  let selectIdx = 0;
  const makeThenable = (behavior: SelectBehavior, rows: unknown[]) => ({
    then(onFulfilled: (rows: unknown[]) => unknown, onRejected?: (err: unknown) => unknown) {
      if (behavior === "throw") {
        const err = new Error("simulated store timeout");
        return onRejected ? Promise.resolve(onRejected(err)) : Promise.reject(err);
      }
      return Promise.resolve(onFulfilled(rows));
    },
  });
  return {
    select: () => {
      const behavior = opts.selects[selectIdx] ?? "empty";
      const rows = opts.selectRows?.[selectIdx] ?? [];
      selectIdx += 1;
      const chain = {
        from: () => chain,
        where: () => makeThenable(behavior, rows),
      };
      return chain;
    },
    update: () => ({
      set: () => ({
        where: async () => {
          if (opts.updateThrows) throw new Error("simulated touch write timeout");
        },
      }),
    }),
  } as unknown as Db;
}

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const COMPANY_ID = "22222222-2222-2222-2222-222222222222";

describe("actorMiddleware structured reject-reason logging (ANT-1202)", () => {
  beforeEach(() => {
    logCalls.length = 0;
    jwtClaims = null;
  });

  it("logs unknown_agent_key at debug for a token that matches no key and is not a JWT", async () => {
    const mw = actorMiddleware(makeDb({ selects: ["empty"] }), { deploymentMode: "authenticated" });
    const req = makeReq("totally-unknown-token");
    const res = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(req.actor.type).toBe("none");
    const reject = logCalls.find((c) => c.obj.authReject === "unknown_agent_key");
    expect(reject).toBeTruthy();
    expect(reject?.level).toBe("debug");
    // Never log the raw token; only a short hash prefix.
    expect(reject?.obj.tokenHashPrefix).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(reject?.obj)).not.toContain("totally-unknown-token");
  });
});

describe("actorMiddleware db_lookup_error -> 503 + Retry-After (ANT-1204)", () => {
  beforeEach(() => {
    logCalls.length = 0;
    jwtClaims = null;
  });

  it("responds 503 + Retry-After (not next()/401) when the agent-key lookup throws", async () => {
    const mw = actorMiddleware(makeDb({ selects: ["throw"] }), { deploymentMode: "authenticated" });
    const req = makeReq("valid-looking-key");
    const res = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    // Behaviour change: middleware short-circuits with 503 instead of
    // degrading to an unauthenticated actor + downstream 401.
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("2");
    expect((res.body as { error?: string }).error).toBe("auth_store_unavailable");
    expect((res.body as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(2);

    // Still emits the structured warn signal.
    const reject = logCalls.find((c) => c.obj.authReject === "db_lookup_error");
    expect(reject).toBeTruthy();
    expect(reject?.level).toBe("warn");
    expect(reject?.obj.stage).toBe("agent_api_key_lookup");
    expect(reject?.obj.err).toBeInstanceOf(Error);
    expect(reject?.obj.tokenHashPrefix).toMatch(/^[0-9a-f]{12}$/);
  });

  it("responds 503 + Retry-After when the JWT agent lookup throws", async () => {
    jwtClaims = { sub: AGENT_ID, company_id: COMPANY_ID };
    // First select (agent key lookup) is empty -> falls into JWT path; second
    // select (jwt agent lookup) throws.
    const mw = actorMiddleware(makeDb({ selects: ["empty", "throw"] }), { deploymentMode: "authenticated" });
    const req = makeReq("jwt-token");
    const res = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("2");
    const reject = logCalls.find((c) => c.obj.authReject === "db_lookup_error");
    expect(reject?.level).toBe("warn");
    expect(reject?.obj.stage).toBe("jwt_agent_lookup");
  });

  it("responds 503 + Retry-After when the agent record lookup behind a valid key throws", async () => {
    // First select (agent key lookup) returns a valid key row; second select
    // (agent record lookup) throws. The lastUsedAt touch succeeds.
    const keyRow = { id: "key-1", agentId: AGENT_ID, companyId: COMPANY_ID, revokedAt: null, keyHash: "h" };
    const mw = actorMiddleware(
      makeDb({ selects: ["ok", "throw"], selectRows: [[keyRow], []] }),
      { deploymentMode: "authenticated" },
    );
    const req = makeReq("valid-key");
    const res = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("2");
    const reject = logCalls.find((c) => c.obj.authReject === "db_lookup_error" && c.obj.stage === "agent_key_agent_lookup");
    expect(reject).toBeTruthy();
    expect(reject?.level).toBe("warn");
  });

  it("keeps the best-effort lastUsedAt touch NON-FATAL: a valid key still authenticates when the touch write throws", async () => {
    const keyRow = { id: "key-1", agentId: AGENT_ID, companyId: COMPANY_ID, revokedAt: null, keyHash: "h" };
    const agentRow = { id: AGENT_ID, companyId: COMPANY_ID, status: "active" };
    // First select returns the key, second select returns the (active) agent.
    // The update() (lastUsedAt touch) throws but must not fail the request.
    const mw = actorMiddleware(
      makeDb({ selects: ["ok", "ok"], selectRows: [[keyRow], [agentRow]], updateThrows: true }),
      { deploymentMode: "authenticated" },
    );
    const req = makeReq("valid-key");
    const res = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    // Non-fatal: request proceeds as an authenticated agent, no 503.
    expect(res.statusCode).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.actor.type).toBe("agent");
    expect((req.actor as { agentId?: string }).agentId).toBe(AGENT_ID);

    // The touch failure is still logged as db_lookup_error at the touch stage,
    // but did not short-circuit the request.
    const touchReject = logCalls.find(
      (c) => c.obj.authReject === "db_lookup_error" && c.obj.stage === "agent_api_key_touch",
    );
    expect(touchReject).toBeTruthy();
    expect(touchReject?.level).toBe("warn");
  });
});
