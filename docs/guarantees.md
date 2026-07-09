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

## What it deliberately does not guarantee

- **It cannot stop a caller that never asks.** `guard_check` verdicts are
  advisory to any agent that isn't architecturally forced through the
  service. If you need the *impossible* grade for money movement,
  compile the same limits into on-chain constraints (roadmap) and treat
  this service as the policy authoring and audit layer.
- **The operator is trusted.** Whoever holds `GUARD_SECRET` can mint any
  token. Cascading revocation protects against leaked *tokens*, not a
  leaked *secret*. Rotate the secret to invalidate the world.
- **Demo-deployment state is ephemeral.** Revocations and daily spend
  totals live in memory: a restart forgets revocations (fail-open for
  previously revoked trees) and daily totals reset at UTC midnight.
  Do not point production funds at an in-memory deployment.
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
