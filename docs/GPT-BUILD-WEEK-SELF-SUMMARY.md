# OpenAI Build Week — Codex/GPT-5.6 self-summary

> **Authorship note:** This summary is written by Codex (GPT-5.6), the AI
> coding agent that implemented the Build Week work, in its own voice—every
> “I” below refers to Codex, not to the repository owner. The owner (`ckeda`,
> Keda) directed the project, adjudicated design decisions, performed deploys
> and human approvals, and did not author this document's claims. Commit
> metadata shows `ckeda` because the shared workspace uses the owner's Git
> identity.

## Scope boundary

Claw-in-a-Box v0.1–v0.8.0 is pre-existing product history and
production/staging infrastructure. I did **not** build that service line, and it
is not Build Week submission work. The existing v0.8.0 code at commit
[`676fd5d`](https://github.com/ckeda/claw-in-a-box/commit/676fd5d) is the baseline
on which the Build Week work starts.

My Build Week contribution, implemented with Codex + GPT-5.6, is exactly:

1. the operator Console, built from scratch;
2. the v0.8.1 “Locks” server increment; and
3. the v0.9.0 “Face” server increment.

The recorded Codex core-build session is
`019f75a2-5efc-70e1-818e-2514176abc6a`. The repository uses the owner's Git
identity, so commit author metadata says `ckeda`; the session ID records the
Codex/GPT-5.6 implementation work performed in the shared workspace.

## What I built

### 1. Claw Console

The Console is a static React/TypeScript operator workbench in [`console/`](../console/).
Its first implementation is commit
[`12e479d`](https://github.com/ckeda/claw-in-a-box/commit/12e479d) on
`agent/console-build-week`, tracked by
[Draft PR #1](https://github.com/ckeda/claw-in-a-box/pull/1).

I built:

- a live health Dashboard and public aggregate metrics view;
- Verdict Lab for explainable `allow | review | deny` policy decisions;
- the approval timeline used for the real Telegram human-in-the-loop demo;
- a capability-token workbench that decodes and renders delegation trees,
  verifies tokens through the API, and visualizes cascading revocation;
- Telegram binding and policy-preset views;
- v0.9 approval-feed, agent spend, strict-mode, and wallet-recovery surfaces;
- a typed, explicit free-endpoint allowlist that rejects `/paid/*`,
  `/paid-okx/*`, unknown routes, and wrong methods before `fetch`; and
- bounded browser state, responsive presentation, masked credential controls,
  per-slot clearing, and a restrictive CSP with no third-party runtime scripts.

The Console does not pretend UI visibility is authorization. Visitor access is
public. One agent-owner secret can be stored in localStorage for single-agent
operations. The higher-value operator key is sessionStorage/in-memory only and
is transmitted only in the `Authorization` header.

### 2. v0.8.1 “Locks”

The v0.8.1 work is on `agent/v0.8.1`, tracked by
[Draft PR #2](https://github.com/ckeda/claw-in-a-box/pull/2). Its implementation
starts at [`31cf788`](https://github.com/ckeda/claw-in-a-box/commit/31cf788) and
continues through `101c7dd`, `fc14917`, and `39ae89a`.

I added:

- paid-only Pay-to-Claim on both x402 rails, returning a one-time agent secret
  whose SHA-256 hash is stored durably;
- authenticated secret rotation, claimed-agent Telegram rebinding, and the
  public strict-mode toggle;
- one-shot `verdict_id` execution binding, single consumption, expiry, same-day
  refunds, and pending-verdict restart hydration;
- durable audit events for claims, payer mismatches, bindings, approvals,
  verdict lifecycle, and token revocation;
- settlement-payer ground truth and visible payer-mismatch accounting;
- `DISCOVERY=off` so permanent staging cannot be indexed by the public Bazaar;
  and
- GET discovery probes for both claim rails, with rejected business input
  checked before settlement.

Claim, rotate, and strict-mode security paths fail closed with HTTP 503 unless
`PERSISTENCE=on`, the database is connected, and hydration is complete. They
never fall back to memory.

### 3. v0.9.0 “Face”

The v0.9 work is on `agent/v0.9.0`, tracked by
[Draft PR #3](https://github.com/ckeda/claw-in-a-box/pull/3). The reviewed design
is commit [`8673a4d`](https://github.com/ckeda/claw-in-a-box/commit/8673a4d);
implementation is
[`1d455af`](https://github.com/ckeda/claw-in-a-box/commit/1d455af).

I added three database-backed operational APIs:

- operator-only `GET /v1/approvals?status=&limit=`;
- agent-secret-scoped `GET /v1/agents/:id/spend`; and
- public, aggregate-only `GET /v1/metrics`.

I also added EOA/EIP-191 wallet-signature secret recovery. The server issues a
five-minute, domain-bound challenge, stores only the nonce hash, reconstructs
the canonical message, verifies the settlement wallet, and rotates the secret
inside one SQL transaction. The transaction locks both nonce and agent rows
with `FOR UPDATE`; the nonce transition is conditional on `used_at IS NULL`.
Only one concurrent submission can commit. Expired nonce rows are swept.
Contract/custodial-wallet recovery is explicitly deferred to manual operator
recovery rather than presented as supported.

The v0.9 spend ledger is observational only: v0.9-forward, PII-minimized,
fire-and-forget, fixed to the latest 50 rows in the response, and retained for
90 days. It is never consulted to authorize spend. I also normalized concurrent
duplicate claims to 409 before settlement and added informational rate-limit
headers without changing response bodies.

## Hard engineering problems and their checks

### Fail-closed security

All new identity, operational-read, and recovery features check the hydrated
database boundary and return 503 when it is unavailable. Ordinary pre-existing
free operations remain usable. Tests exercise `PERSISTENCE=off`, dead-DB, and
missing-operator-key cases in [`service/test-v081.js`](../service/test-v081.js)
and [`service/test-v09.js`](../service/test-v09.js).

### Atomic recovery and replay resistance

[`service/storage.js`](../service/storage.js) implements the recovery
transaction with row locks, expiry/use checks, secret-hash update, conditional
nonce consumption, commit-before-cache-update, and rollback. Tests cover wrong
wallet, malformed proof, expiry, replay, concurrent replay, restart survival,
cross-domain replay, and expired-row cleanup.

### Byte-stable free-tier compatibility

The five original NANDA endpoints remain free for unclaimed, non-strict agents
and retain their v0.8 response bodies. [`service/test-v081.js`](../service/test-v081.js)
and [`service/test-v09.js`](../service/test-v09.js) assert that they never become
402/403 and that the recorded body shapes remain stable. Rate-limit work is
header-only.

### CORS without credential mode

The server adds only `authorization` to the existing allowed request headers.
It retains wildcard origin because the Console is a public static client, does
not emit `Access-Control-Allow-Credentials`, and exposes only retry/rate-limit
response headers. This is asserted in the v0.9 suite.

### Operator god-view versus agent-owner boundary

The approval list contains amounts and destinations, so it accepts only the
operator bearer key, compared through equal-length SHA-256 digests and
`timingSafeEqual`. An agent secret cannot list approvals. Agent spend is scoped
to the path agent and requires that agent's secret; the operator key cannot
bypass it. v0.9 adds no operator mutation or approval override.

## Engineering process and verification

I did not silently guess through security ambiguities. For v0.8.1 I raised four
design questions: the strict-mode public contract, restart hydration for
pending verdicts, re-evaluation after human approval, and payer mismatch after
settlement. The owner adjudicated each one before I implemented it. Follow-up
staging findings produced separately reviewed changes for discovery suppression
and GET claim probes.

For v0.9 I wrote the design note first. The owner approved it with a required
credential-storage correction—operator key session-only, never localStorage—and
seven explicit decisions covering history integration, approval retention,
spend ledger, recovery scope/rates, key rotation, and operator mutations.

The test counts come directly from the checked-in test files:

| suite | named call sites | runtime assertions |
|---|---:|---:|
| pre-existing baseline, `service/test-v2.js` | 38 | 38 |
| Build Week v0.8.1, `service/test-v081.js` | 77 | 86 |
| Build Week v0.9.0, `service/test-v09.js` | 43 | 43 |
| complete server matrix | 158 | 167 |
| Console Vitest suite | 20 | 20 |

The distinction matters because nine v0.8.1 assertions execute from shared
loops: static `ok()` call-site counting reports 77, while `node test-all.js`
prints 86 v0.8.1 PASS lines. The reproducible headline is therefore **167
server runtime assertions plus 20 Console tests** (158 named server cases).
I ran the complete matrix on Node 18.20.8 and Node 22.23.1; the independent
reviewer confirmed the 167 runtime total on Node 20 and Node 22. The Console
production build passed. The Node-18-critical `jose` dependency remains on v5
through the package override.

The owner controls merge-facing actions, deployment, Telegram, wallets, and
Hostinger. v0.8.1 passed the owner's independent sandbox re-review and the real
restart-survival staging acceptance on `test.clawinabox.xyz`. v0.9.0 has now
passed independent review, is deployed to that permanent staging host, and has
passed the owner's manual acceptance for contract invariants, the access model,
and the wallet-recovery loop. Draft PR #3 intentionally remains open: mainnet
is frozen through the July 21 submission, merge follows the mainnet promotion
chain, and `console.clawinabox.xyz` remains frozen. GitHub currently records no
formal review objects on the three Draft PRs; the independent review and owner
adjudication record lives in the owner/Codex task log.

## Reproducible references

- Repository: <https://github.com/ckeda/claw-in-a-box>
- Core-build session: `019f75a2-5efc-70e1-818e-2514176abc6a`
- Console: `agent/console-build-week`, Draft PR #1, initial commit `12e479d`
- v0.8.1: `agent/v0.8.1`, Draft PR #2, commits `31cf788` → `39ae89a`
- v0.9.0: `agent/v0.9.0`, Draft PR #3, implementation commit `1d455af`
- `deploy-v0.8.1-staging.zip` SHA-256:
  `84944d09db69f40a49c6ef88e8a5d35d5583d1a582db42fa7efdc93373863564`
- corrected `deploy-v0.9.0-staging.zip` SHA-256:
  `b8c360bce3a6d4e562a31c7e3458cff24fc1cf86048419f9778ee49f33b13d20`

No statement above attributes v0.1–v0.8.0 to Codex or to the Build Week entry.
