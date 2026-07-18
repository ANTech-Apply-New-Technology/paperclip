# OpenClaw Gateway Adapter

This document describes how `@paperclipai/adapter-openclaw-gateway` invokes OpenClaw over the Gateway protocol.

## Transport

This adapter always uses WebSocket gateway transport.

- URL must be `ws://` or `wss://`
- Connect flow follows gateway protocol:
1. receive `connect.challenge`
2. send `req connect` (protocol/client/auth/device payload)
3. send `req agent`
4. wait for completion via `req agent.wait`
5. stream `event agent` frames into Paperclip logs/transcript parsing

## Auth Modes

Gateway credentials can be provided in any of these ways:

- `authToken` / `token` in adapter config
- `headers.x-openclaw-token`
- `headers.x-openclaw-auth` (legacy)
- `password` (shared password mode)

When a token is present and `authorization` header is missing, the adapter derives `Authorization: Bearer <token>`.

## Device Auth

By default the adapter sends a signed `device` payload in `connect` params.

- set `disableDeviceAuth=true` to omit device signing
- set `devicePrivateKeyPem` to pin a stable signing key
- without `devicePrivateKeyPem`, the adapter generates an ephemeral Ed25519 keypair per run
- when `autoPairOnFirstConnect` is enabled (default), the adapter handles one initial `pairing required` by calling `device.pair.list` + `device.pair.approve` over shared auth, then retries once.

## Session Strategy

The adapter supports the same session routing model as HTTP OpenClaw mode:

- `sessionKeyStrategy=issue|fixed|run`
- `sessionKey` is used when strategy is `fixed`

Resolved session key is sent as `agent.sessionKey`.

## Payload Mapping

The agent request is built as:

- required fields:
  - `message` (wake text plus optional `payloadTemplate.message`/`payloadTemplate.text` prefix)
  - `idempotencyKey` (Paperclip `runId`)
  - `sessionKey` (resolved strategy)
- optional additions:
  - all `payloadTemplate` fields merged in
  - `agentId` from config if set and not already in template

## Timeouts

- `timeoutSec` controls adapter-level request budget
- `waitTimeoutMs` controls `agent.wait.timeoutMs`

If `agent.wait` returns `timeout`, adapter returns `openclaw_gateway_wait_timeout`.

## Log Format

Structured gateway event logs use:

- `[openclaw-gateway] ...` for lifecycle/system logs
- `[openclaw-gateway:event] run=<id> stream=<stream> data=<json>` for `event agent` frames

UI/CLI parsers consume these lines to render transcript updates.

## Upstream Divergence: `agentParams.paperclip`

> **⚠️ Warning — do not re-add `agentParams.paperclip`.**
>
> The OpenClaw Gateway server validates `agentParams` strictly: its `AgentParamsSchema`
> uses `additionalProperties: false` (AJV, runtime 2026.4.11), so any unknown property
> on `agentParams` causes the gateway to reject the request at validation time.
>
> The Antech fork therefore does **not** set `agentParams.paperclip` on the outgoing
> agent request. This is permanent for the fork.

### Background

- **`4af590cf`** (Martin Bilger, 2026-04-22) — *“fix: remove paperclip property from
  agentParams — openclaw rejects unknown props”* — removed the
  `agentParams.paperclip = paperclipPayload` assignment in
  `packages/adapters/openclaw-gateway/src/server/execute.ts`.
- Upstream later added wake-payload batching logic (commit `91e040a6`) whose tests
  assert that `agentParams.paperclip.wake = {...}` is present. Those assertions reflect
  upstream behaviour and **do not apply to this fork**.
- Sigge's investigation in **ANT-1000** re-confirmed that the gateway server still
  rejects unknown `agentParams` properties on runtime `2026.4.11`, so the fork's
  decision stands.

Related issues:

- **ANT-997** — Reconcile upstream-merge regression (root context).
- **ANT-999** — Pipeline coordination follow-up.
- **ANT-1000** — Gateway-server validation verification (closed: still strict).

### Guidance for Future Upstream Merges

When merging from upstream `openclaw/paperclip`:

1. **Do not reintroduce `agentParams.paperclip`** in `src/server/execute.ts`. Wake
   metadata reaches the agent via the `message` payload (and other already-allowed
   fields), not via `agentParams`.
2. Check the following test files and keep their assertions aligned with the fork
   contract (no `agentParams.paperclip`, wake info carried in the message string):
   - `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
   - `server/src/__tests__/openclaw-gateway-adapter.test.ts`
3. If upstream merge conflicts try to re-add the `paperclip` property or restore
   `toMatchObject({ paperclip: { wake: ... } })` assertions, resolve them in favour
   of the fork (omit the property, assert on `message`/wake fields the gateway
   accepts).
4. If a future gateway release relaxes `additionalProperties` (or adds an explicit
   `paperclip` slot to `AgentParamsSchema`), re-open **ANT-997** and re-evaluate
   before reverting `4af590cf`.
