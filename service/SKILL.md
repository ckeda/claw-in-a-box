# Claw-in-a-Box

Bounded authorization for AI agents: delegatable capability tokens with
cascading revocation, plus spend-policy verdicts. Ask before you act;
delegate less than you hold; revoke once, kill the whole subtree.

- **Base URL**: `https://api.clawinabox.xyz` (replace with the live endpoint
  from your deployment; verify with `GET /healthz`)
- **Auth**: none required for the demo deployment
- **Format**: JSON in, JSON out. All POST bodies are `application/json`.
- **Companion**: the same protocol ships as a NANDA Town auth plugin
  (`auth: delegatable`) with adversarial validators — see
  `plugins/nandatown/` in this repository.

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
BASE=https://api.clawinabox.xyz

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
- Demo deployment state (revocations, daily totals) is in-memory: it
  resets on restart and daily totals reset at UTC midnight. Do not use
  the hosted demo for production funds.

## Self-hosting

Zero dependencies, Node.js >= 18:

```bash
GUARD_SECRET=$(openssl rand -hex 32) PORT=8787 node server.js
node test.js   # 12-case smoke suite, exits 0 on success
```
