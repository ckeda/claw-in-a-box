# Claw-in-a-Box

Bounded authorization for AI agents: delegatable capability tokens with
cascading revocation, plus spend-policy verdicts. Ask before you act;
delegate less than you hold; revoke once, kill the whole subtree.

- **Base URL**: `{{BASE_URL}}` (this service runs on two hosts with
  different payment rails - see "Deployments" below; verify with `GET /healthz`)
- **Auth**: public endpoints remain unauthenticated for unclaimed agents.
  Claimed identity mutations use `X-Agent-Secret`; a claimed agent in strict
  mode also requires that header on guard checks.
- **Format**: JSON in, JSON out. All POST bodies are `application/json`.
- **Companion**: the same protocol ships as a NANDA Town auth plugin
  (`auth: delegatable`) with adversarial validators — see
  `plugins/nandatown/` in this repository.

## Deployments

The same codebase serves two hosts. Free routes (`/v1/*`) are identical on
both; paid routes (`/paid/v1/*`) run the same business logic and differ only
in how the x402 payment settles:

| Endpoint prefix | Payment rail | Listed on |
|---|---|---|
| `https://api.clawinabox.xyz/paid/v1/*` | USDC on Base (`eip155:8453`), Coinbase CDP facilitator | x402 Bazaar / Agentic.Market |
| `https://api.clawinabox.xyz/paid-okx/v1/*` | USDT0 on X Layer (`eip155:196`), OKX OnchainOS facilitator | OKX.AI |
| `https://okx.clawinabox.xyz/paid/v1/*` | USDT0 on X Layer (legacy alias, kept alive) | — |

The 402 challenge you receive on either host declares the correct network,
asset and amount for that host - clients should always read the challenge
rather than hardcoding payment details.

## What this service is for

You are an agent. Sometimes you need to hand a *narrower* version of your
authority to another agent (a sub-task worker, a tool, a session) without
asking the original issuer. Sometimes you are about to spend money and
should check the action against a policy first. This service does both:

1. **Capability tokens** — mint a root capability, delegate attenuated
   children offline, verify presented tokens, revoke with cascade.
   Attenuation is enforced: a child can never hold a scope its parent
   lacks, never outlive its parent, and is bound to a single audience.
2. **Spend guard** — send a proposed action, get back
   `allow | review | deny` with the exact rules that fired. `review`
   means: pause and get a human's confirmation before proceeding.

## Quickstart (60 seconds)

```bash
BASE={{BASE_URL}}

# 1) health
curl -s $BASE/healthz

# 2) check a spend before doing it
curl -s -X POST $BASE/v1/guard/check \
  -d '{"agent_id":"my-agent","action":"transfer","amount":150,"destination":"0xabc"}'
# -> {"verdict":"review","triggered_rules":["require_approval"],...}

# 3) mint a root capability and delegate a narrower one
ROOT=$(curl -s -X POST $BASE/v1/tokens \
  -d '{"subject":"my-agent","scopes":["read","write","pay"]}' | jq -r .token)
curl -s -X POST $BASE/v1/tokens/delegate \
  -d "{\"parent_token\":\"$ROOT\",\"audience\":\"worker-1\",\"scopes\":[\"read\"],\"ttl_seconds\":600}"
```

## Endpoint reference

### POST /v1/guard/check — spend-policy verdict

Ask before acting. Send the action you intend to take.

Request fields:

| field | type | required | notes |
|---|---|---|---|
| `agent_id` | string | no | identity for daily accumulation (default `anonymous`) |
| `action` | string | no | free-form label, e.g. `transfer`, `api_call` |
| `amount` | number | yes for spends | in whatever unit your policy uses |
| `destination` | string | no | checked against allowlist rules if present |
| `policy` | string or object | no | preset name (`conservative` / `standard` / `permissive`, default `standard`) or an inline policy object (schema below) |
| `bind` | boolean | no | when `true`, an `allow` (or later human approval) also returns a one-shot execution `verdict_id` |

Response:

```json
{
  "verdict": "allow | review | deny",
  "triggered_rules": ["spend_limit.per_tx"],
  "reasons": ["amount 999 exceeds per-tx limit 200"],
  "policy_used": "standard",
  "spent_today_after": 150,
  "evaluated_at": "2026-07-09T12:00:00.000Z"
}
```

How to interpret the verdict:

- `allow` — proceed. The amount is recorded against the agent's daily total.
- `review` — do **not** proceed autonomously. Surface the action to your
  human operator and only continue on explicit confirmation.
- `deny` — do not proceed, do not retry with the same parameters.
  `reasons` tells you which limit to respect.

Presets (`GET /v1/policies` returns them in full):

| preset | per-tx | daily | review above |
|---|---|---|---|
| `conservative` | 50 | 200 | 20 |
| `standard` | 200 | 1000 | 100 |
| `permissive` | 1000 | 5000 | 500 |

Inline policy schema (four primitives):

```json
{
  "name": "my-policy",
  "rules": [
    {"type": "spend_limit", "per_tx": 200, "daily": 1000},
    {"type": "allowlist", "field": "destination", "values": ["0xgood"]},
    {"type": "require_approval", "when_amount_over": 100},
    {"type": "time_window", "allow_utc_hours": [[9, 18]]}
  ]
}
```

Rule semantics: `spend_limit` denies when a single amount exceeds
`per_tx` or when the agent's accumulated daily total would exceed
`daily`; `allowlist` denies any `destination` not listed (omit or set
`"mode": "off"` to disable); `require_approval` downgrades the verdict
to `review` above the threshold; `time_window` denies outside the given
UTC hour ranges. `deny` always wins over `review`.

For execution binding, send `"bind": true`. An allowed decision includes
`{"verdict_id":"...","expires_in_seconds":300}`. Present that id once:

```bash
curl -s -X POST "$BASE/v1/verdicts/$VERDICT_ID/consume" -d '{}'
```

The first consume returns 200; a second returns `409 already_consumed` with
the first consumption time. Unknown or expired ids return 404. If a bound
allow is not consumed before expiry, its same-day spend charge is refunded.
Pending ids survive a single-instance restart with only their remaining
expiry. Human approval is final for that request: an approved request is
charged at resolution without re-evaluating machine limits, and may push the
day over its cap by design; subsequent automated verdicts see the higher
ledger total and tighten naturally. Without `bind`, the v0.8 response shape is
unchanged.

### POST /v1/tokens — issue a root capability

```json
{"subject": "my-agent", "scopes": ["read", "write", "pay"], "ttl_seconds": 3600}
```
Returns `{"token": "<base64url>"}`. `ttl_seconds` defaults to 3600.

### POST /v1/tokens/delegate — mint an attenuated child (offline)

```json
{"parent_token": "<token>", "audience": "worker-1", "scopes": ["read"], "ttl_seconds": 600}
```

Returns `{"token": "<child token>"}`. Rules the service enforces:

- child `scopes` must be a subset of the parent's, else
  `403 scope_escalation`;
- child expiry is clamped to the parent's (a child never outlives its
  parent);
- a revoked or expired parent cannot delegate.

Any token holder can delegate — no issuer round-trip. Chains can be
arbitrarily deep; every hop attenuates.

### POST /v1/tokens/verify — verify a presented token

```json
{"token": "<token>", "presenter": "worker-1"}
```

`presenter` is optional but recommended: when present, the service also
checks the token is being presented by its bound audience. Success:

```json
{"valid": true, "context": {"subject": "worker-1", "scopes": ["read"],
 "expires_at": 1760000000, "chain_tids": ["a1b2...", "c3d4..."], "depth": 2}}
```

Failures return HTTP 400/403 with `{"valid": false, "verdict": "deny",
"error": "<code>", "detail": "<human readable>"}` where `error` is one of
`invalid_token`, `invalid_signature`, `scope_escalation`,
`expired_ancestor`, `revoked_ancestor`, `audience_mismatch`,
`missing_field`.

### POST /v1/tokens/revoke — revoke with cascade

```json
{"token": "<token>"}
```

Returns `{"revoked_tid": "...", "cascades": true}`. Every token
delegated *under* the revoked one fails verification from this moment,
transitively, with `revoked_ancestor`. Revoke the root to kill the
entire tree.

## Recommended agent patterns

**Sub-delegating a task.** Before handing work to another agent, do not
share your own token. Call `/v1/tokens/delegate` with only the scopes
the sub-task needs and a short `ttl_seconds`. When the task is done or
the worker misbehaves, `POST /v1/tokens/revoke` on the child you minted.

**Gating your own spends.** Before any irreversible or costly action,
call `/v1/guard/check` with a stable `agent_id`. Treat `review` as a
hard stop pending human confirmation, not as a soft warning.

**Verifying what others present to you.** When another agent presents a
token to request something from you, call `/v1/tokens/verify` with
`presenter` set to that agent's id, and check the returned `scopes`
cover the request before serving it.

## Guarantees and limits (read this)

- Tokens are HMAC-chained (macaroon-style): attenuation and cascading
  revocation are enforced by construction at every verify, on the
  server. Clients cannot forge or broaden tokens without the secret.
- These are *gateway-grade* guarantees: they hold as long as callers
  route decisions through this service. The service cannot physically
  stop an agent that ignores a `deny` — for protocol-grade enforcement
  of the same policy semantics, compile them to on-chain session-key
  constraints (on the roadmap).
- In `PERSISTENCE=on`, revocations, today's spend, bindings, pending
  approvals, claimed identities, verdict rows, and audit events are persisted.
  Pending verdicts hydrate on restart and re-arm their remaining expiry; a
  verdict that expired during downtime is refunded by the first boot sweep.
  Runtime verdict consumption remains Map-authoritative, so this is a
  single-instance restart guarantee, not multi-replica coordination.

## Pay-to-Claim identity

Agent ids are claimed only through x402 payment—there is no free claim path:

```text
POST /paid/v1/agents/claim      {"agent_id":"my-agent"}
POST /paid-okx/v1/agents/claim {"agent_id":"my-agent"}
```

After the normal 402 handshake and successful settlement, the first claim
returns HTTP 201:

```json
{
  "agent_id": "my-agent",
  "agent_secret": "<shown exactly once>",
  "claimed_at": "2026-07-19T00:00:00.000Z",
  "claimed_by": "0x...payer wallet"
}
```

The `claimed_by` value serialized into the 201 response is the
facilitator-verified payer and is provisional until settlement completes. The
settlement payer is the durable on-chain ground truth. If the two differ, the
claim remains valid, `claimed_by` is stored from settlement, and the service
records `claim_payer_mismatch` in both audit history and `/healthz` counters.

Store `agent_secret` immediately; only its SHA-256 hash is retained. A repeated
claim returns `409 already_claimed` and is not settled. Rotate a secret with:

```bash
curl -s -X POST "$BASE/v1/agents/rotate" \
  -H "X-Agent-Secret: $AGENT_SECRET" \
  -d '{"agent_id":"my-agent"}'
```

Rotation atomically invalidates the old secret and returns the replacement
once. Toggle strict guard authentication with:

```bash
curl -s -X POST "$BASE/v1/agents/strict" \
  -H "X-Agent-Secret: $AGENT_SECRET" \
  -d '{"agent_id":"my-agent","strict":true}'
```

The response is `{"agent_id":"my-agent","strict_mode":true}`; send
`"strict":false` to turn it off. Claim, rotation, and strict-mode changes
return `503 feature_disabled` unless the deployment is using a connected,
hydrated MySQL database with `PERSISTENCE=on`. Never put the secret in a query
string or JSON body.


## Paid endpoints (x402 pay-per-call)

Mirrors of the endpoints above, gated by the x402 payment standard —
these are the endpoints listed on OKX.AI (A2MCP):

- `POST /paid/v1/guard/check` — same request/response as the free route.
- `POST /paid/v1/tokens/verify` — same request/response as the free route.
- `POST /paid/v1/agents/claim` — paid-only identity claim; the `/paid-okx`
  mirror uses the OKX rail.

Flow (x402 v2, official OKX Payment SDK, A2MCP standard):

1. Call without payment (GET or POST) → `HTTP 402`. The `PAYMENT-REQUIRED`
   response header is **base64-encoded JSON**:
   `{"x402Version":2,"resource":{...},"accepts":[...]}` with
   `accepts[0]`: scheme `exact`, network `eip155:196` (X Layer), asset
   USDT0 (`0x779d…3736`), amount `10000` (0.01 USDT, 6 decimals),
   `payTo` the service's X Layer address, and the USDT0 EIP-712 domain in
   `extra` (`{"name":"USD₮0","version":"1"}`).
2. Sign the payment (EIP-3009 `transferWithAuthorization`) and retry with
   the base64 `PAYMENT-SIGNATURE` header.
3. The SDK verifies with the OKX facilitator, the service runs the
   verdict, and the payment settles on success — you get the verdict plus
   a `PAYMENT-RESPONSE` header. Failed business logic is never settled.

## Human-in-the-loop approvals

A `review` verdict routes to a human on Telegram for approval — no
approval, no money. By default this goes to the service operator, but
**you can bind your own Telegram so your agent's reviews come to your
phone**:

1. `POST /v1/operators/register` with `{"agent_id":"<your-agent>"}` →
   returns a one-time `bind_code`. If the id is claimed, also send its
   `X-Agent-Secret`; unclaimed ids retain the legacy flow.
2. Message the Claw-in-a-Box bot on Telegram: `/bind <bind_code>`.
3. From then on, any `review` for that `agent_id` is sent to *your*
   chat with Approve / Deny buttons. Unbound agents fall back to the
   operator.

When a `review` fires, the response includes the approval workflow:

```json
{
  "verdict": "review",
  "approval_id": "a1b2c3d4e5f60708",
  "approval_status": "pending",
  "poll": "/v1/approvals/a1b2c3d4e5f60708",
  "note": "A human has been notified on Telegram..."
}
```

- Poll `GET /v1/approvals/{id}` until `status` becomes `approved`,
  `denied`, or `expired` (`final_verdict` is `allow` or `deny`).
- Or send `"wait": true` in the original request to block until a human
  decides (or the timeout passes — default 120s, then denied).

A human operator tapping **Approve** is the only way a `review`
becomes an `allow`. Enforce before, not audit after.

## Self-hosting

Node.js >= 18 and MySQL for persistent identity features:

```bash
npm install
GUARD_SECRET=$(openssl rand -hex 32) PORT=8787 node server.js
node test-all.js
```
