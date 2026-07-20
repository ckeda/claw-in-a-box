# Guarantees — what is enforced, by whom, and what is not

Security tools earn trust by being precise about their limits. This page
states exactly what Claw-in-a-Box guarantees at each layer, and what it
cannot.

## The grading scheme

A policy constraint can be enforced at different strengths:

- **protocol-enforced** — violating the constraint is *impossible*: it is
  rejected by a consensus layer or cryptographic construction that no
  single operator controls. Example: an ERC-4337 session key whose spend
  limit is checked by the chain itself.
- **gateway-enforced** — the constraint is checked by a service on every
  request. It holds as long as (a) callers route through the service and
  (b) the service and its secret are not compromised.
- **advisory** — the constraint is a verdict the caller is expected to
  obey. Nothing stops a caller that ignores it.

## What this service guarantees (gateway grade)

Within the trust boundary of a correctly deployed instance (secret kept
secret, TLS in front, callers routed through it):

| property | mechanism |
|---|---|
| a child token never holds a scope its parent lacks | subset check at mint *and* re-checked segment-by-segment at every verify |
| a child token never outlives any ancestor | expiry clamped at mint; monotonicity re-checked at verify |
| revoking a token invalidates all descendants | each child's HMAC is keyed by its parent's signature; revocation is checked per segment on every verify |
| tokens cannot be forged or broadened offline | HMAC-SHA256 chain over canonical JSON; constant-time comparison |
| a token is only accepted from its bound audience | `verify` with `presenter` set (callers should always set it) |
| per-tx / daily / allowlist / time-window verdicts are deterministic | pure rule evaluation; `deny` dominates `review` dominates `allow` |
| a claimed agent id cannot be rebound without its secret | paid claim inserts a unique database row; only a SHA-256 secret hash is stored and compared with `timingSafeEqual` |
| the payment wallet anchors a claim | settlement payer is durable `claimed_by`; a verify/settle mismatch preserves the paid claim and emits audit plus health telemetry |
| a bound verdict cannot be consumed twice by this service | one-shot runtime state transition, hydrated when pending after restart; the second consume returns `409 already_consumed` |
| an abandoned bound verdict does not permanently poison same-day budget | unconsumed expiry marks the verdict expired and refunds its same-day ledger charge |

## Three enforcement surfaces in this release

| surface | grade | exact promise |
|---|---|---|
| capability tokens and claimed identity mutations | gateway-enforced | the service rejects invalid chains, revoked ancestors, unauthenticated claimed mutations, and strict guard calls without the agent secret |
| `bind:true` verdicts | execution-bound at the gateway | the service issues one short-lived id and accepts one consume; an executor that requires successful consume closes check-without-spend and spend-twice inside this gateway's trust boundary |
| Telegram human approval | advisory after hand-off | the service will not turn `review` into `allow` without a human resolution, but it cannot force an external wallet or agent to honor that result |

`execution-bound` is not the same as protocol-enforced. It becomes meaningful
only when the component performing the irreversible action refuses to proceed
without a successful consume. A malicious caller can still bypass the gateway
and submit a transaction directly.

## What it deliberately does not guarantee

- **It cannot stop a caller that never asks.** `guard_check` verdicts are
  advisory to any agent that isn't architecturally forced through the
  service. If you need the *impossible* grade for money movement,
  compile the same limits into on-chain constraints (roadmap) and treat
  this service as the policy authoring and audit layer.
- **The operator is trusted.** Whoever holds `GUARD_SECRET` can mint any
  token. Cascading revocation protects against leaked *tokens*, not a
  leaked *secret*. Rotate the secret to invalidate the world.
- **Persistence has an explicit mode boundary.** In `off` and `shadow`, memory
  remains runtime truth and restart guarantees do not apply. In `on`, the
  service hydrates revocations, today's spend, bindings, pending approvals,
  pending verdicts, and claimed identities. Claim, rotation, and strict-mode
  changes fail closed with 503 unless that database is connected and hydrated;
  they never fall back to memory.
- **Verdict consume state is single-instance.** Pending verdicts hydrate and
  re-arm expiry after restart, but the live consume decision follows the
  runtime Map by design. Do not run multiple active replicas and claim global
  exactly-once execution.
- **No confidentiality.** Tokens are signed, not encrypted; scopes and
  audiences are readable by anyone holding the token. Treat tokens as
  bearer credentials and transport them over TLS only.

## Design intent

The interesting engineering question is not "gateway or protocol?" but
"which constraints survive being pushed to the stronger surface, and
what is lost in translation?" Spend caps, allowlists, and expiries
compile cleanly to on-chain session-key constraints; approval hand-offs
(`review`) and rich audit context do not — a transaction cannot be
"paused", only co-signed. A deployment that wants both therefore layers
them: protocol-enforced ceilings underneath, gateway-enforced judgment
on top. This repository is the second layer, built so the first can be
generated from the same policy source.
