import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ANT-1202: The ANT-1201 auth 401 flap left ZERO diagnostic signal because
 * every rejection path in `actorMiddleware` fell through to `next()` silently,
 * so the downstream guard emitted a bare "Agent authentication required" with
 * no reason. These tests pin the new structured reject-reason logging, most
 * importantly that an intermittent store failure is surfaced as
 * `db_lookup_error` (the exact signal missing during the outage) instead of
 * being indistinguishable from an unknown/anonymous caller.
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

// Non-JWT tokens: verifyLocalAgentJwt returns null.
vi.mock("../agent-auth-jwt.js", () => ({
  verifyLocalAgentJwt: () => null,
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

const res = {} as Response;

/**
 * Minimal drizzle-like fake. `select().from().where()` returns a thenable so
 * `.then((rows) => rows[0] ?? null)` works. `behavior` decides whether the
 * read resolves empty or rejects (simulating a transient store failure).
 */
function makeDb(behavior: "empty" | "throw"): Db {
  const thenable = {
    then(onFulfilled: (rows: unknown[]) => unknown, onRejected?: (err: unknown) => unknown) {
      if (behavior === "throw") {
        const err = new Error("simulated store timeout");
        return onRejected ? Promise.resolve(onRejected(err)) : Promise.reject(err);
      }
      return Promise.resolve(onFulfilled([]));
    },
  };
  const chain = {
    from: () => chain,
    where: () => thenable,
  };
  return {
    select: () => chain,
    update: () => ({ set: () => ({ where: async () => {} }) }),
  } as unknown as Db;
}

describe("actorMiddleware structured reject-reason logging (ANT-1202)", () => {
  beforeEach(() => {
    logCalls.length = 0;
  });

  it("logs unknown_agent_key at debug for a token that matches no key and is not a JWT", async () => {
    const mw = actorMiddleware(makeDb("empty"), { deploymentMode: "authenticated" });
    const req = makeReq("totally-unknown-token");
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.actor.type).toBe("none");
    const reject = logCalls.find((c) => c.obj.authReject === "unknown_agent_key");
    expect(reject).toBeTruthy();
    expect(reject?.level).toBe("debug");
    // Never log the raw token; only a short hash prefix.
    expect(reject?.obj.tokenHashPrefix).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(reject?.obj)).not.toContain("totally-unknown-token");
  });

  it("logs db_lookup_error at WARN when the agent-key lookup throws (the ANT-1201 flap signal)", async () => {
    const mw = actorMiddleware(makeDb("throw"), { deploymentMode: "authenticated" });
    const req = makeReq("valid-looking-key");
    const next = vi.fn();

    await mw(req, res, next);

    // Request still degrades to unauthenticated, but now with a real reason.
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.actor.type).toBe("none");

    const reject = logCalls.find((c) => c.obj.authReject === "db_lookup_error");
    expect(reject).toBeTruthy();
    expect(reject?.level).toBe("warn");
    expect(reject?.obj.stage).toBe("agent_api_key_lookup");
    expect(reject?.obj.err).toBeInstanceOf(Error);
    expect(reject?.obj.tokenHashPrefix).toMatch(/^[0-9a-f]{12}$/);
  });
});
