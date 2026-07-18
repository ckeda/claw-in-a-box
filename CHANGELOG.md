# Changelog — Claw-in-a-Box

> Versions v0.2.0–v0.7.5 were shipped as deployment artifacts during a two-week
> hackathon sprint (NANDA Town → OKX AI Genesis → x402 Bazaar) and were not
> pushed to this repository at the time. Development returned to this repo at
> the v0.8.0 baseline. Dates are actual ship dates to production/staging.

> **Build Week boundary:** v0.1–v0.8.0 are pre-existing product history and
> mainnet/staging infrastructure, not submission work. The submission starts
> with the Console below and includes only later server increments authored with
> Codex + GPT-5.6 in the recorded core-build session.

## Unreleased — Claw Console (OpenAI Build Week)
- Static browser-only operator workbench in `console/`
- Live Dashboard, Verdict Lab, Approval timeline, Token Workbench, Telegram binding helper and policy cards
- Client-side free-endpoint allowlist blocks paid and unknown routes before `fetch`
- Polite health/approval/binding polling with explicit `429` backoff
- Bounded localStorage history and token state; no accounts or server-side keys
- Responsive Claw-in-a-Box design system and static-host-compatible hash navigation

## v0.8.1 — "Locks" (unreleased staging candidate)
- Pay-to-Claim (PTC): paid-only `POST /paid/v1/agents/claim` plus `/paid-okx` mirror, one-time 256-bit `agent_secret`, SHA-256-at-rest, and settlement payer recorded as `claimed_by`
- Claimed identities authenticate future operator registration with `X-Agent-Secret`; rotation atomically replaces the stored hash and invalidates the old secret
- Identity features fail closed: claim and rotate return `503 feature_disabled` unless `PERSISTENCE=on` has a connected, hydrated database
- Authenticated `POST /v1/agents/strict` toggles optional strict enforcement on free and paid guard checks without changing unclaimed/non-strict behavior
- Optional `bind:true` issues a one-shot, five-minute `verdict_id`; pending ids hydrate across restart, consume is single-use, and unconsumed same-day verdicts expire with a spend-ledger refund
- Human approval is final for its request and charges at resolution without a second machine-policy evaluation; later automated verdicts use the resulting ledger total
- Settlement payer remains durable claim ground truth; verify/settle mismatches preserve the paid claim and surface through `claim_payer_mismatch` audit plus `/healthz`
- Append-only audit events for claims, mismatches, bindings, approvals, verdict lifecycle and token revocation, with 100,000-row FIFO retention
- Added v0.8.1 integration coverage alongside the original 38 checks, including both x402 rails and the restart-survival acceptance quad

## v0.8.0 — "Memory" (2026-07-16, staging)
- MySQL persistence layer (`storage.js`): `PERSISTENCE=off|shadow|on`
- `shadow`: memory remains runtime source of truth; all mutations fire-and-forget dual-written to DB
- `on`: shadow + boot-time hydration — revoked tokens, today's spend ledger, operator bindings and pending approvals survive restarts; restored approvals re-arm expiry timers with remaining time
- Crash-safe by design: unreachable DB degrades to pure memory with health-endpoint indicators and 60s retry; requests never block on the DB
- 38 local tests across 6 boot modes, incl. dead-DB scenarios

## v0.7.2–v0.7.5 — polish (2026-07-16/17)
- Bazaar catalog tags (`infra`), unified SEO/OpenGraph across all pages
- Live demo widget closes the human-approval loop in the browser ("a real human's phone just buzzed" → verdict flips on approval)
- Status page reflects merged single-instance topology; dual-marketplace copy

## v0.7.1 — migration (2026-07-15)
- Host-independent OKX rail at `/paid-okx/v1/*` (OKX.AI listing "ClawGuard" live on the new endpoint)
- Bazaar `iconUrl` metadata

## v0.7.0 — "Dual rail" (2026-07-15)
- Single instance, dual domain: host-based dispatch — api host `/paid/*` → Coinbase CDP facilitator (USDC on Base, auto-indexed by the x402 Bazaar); everything else → OKX rail (byte-identical v0.6 behavior)
- Unified status page ported; host-aware SKILL.md
- First mainnet x402 settlement on Base; indexed by the Bazaar within one second of settlement

## v0.6.0–v0.6.3 — "Compliance" (2026-07-14)
- x402 layer built on the official OKX SDK for full A2MCP compliance (base64 envelope, GET 402 probes, EIP-712 domain)
- `trust proxy` fix (https resource URLs), Telegram timeout + fire-and-forget + retry
- 26-check live verification script green

## v0.5.0 — "Reliability" (2026-07-13)
- Reliability hardening: bounded all in-memory collections (TTLs/caps), added a periodic sweeper, free-tier rate limiting, and memory metrics in `/healthz`

## v0.4.0 — "Multi-tenant" (2026-07-12)
- Buyers bind their own Telegram: `POST /v1/operators/register` → one-time `/bind CODE`; unbound agents fall back to the operator
- Buyer-facing landing page

## v0.3.0 — polish (2026-07-12)
- 402 dual-channel challenge, dual payment-header compatibility, HMAC signing, verify → business → settle three-phase flow, payment-fingerprint idempotency

## v0.2.0 — "Revenue" (2026-07-11)
- Hand-rolled x402 pay-per-call layer + `/paid/*` mirror routes
- Telegram human-in-the-loop approvals (Approve/Deny inline buttons)

## v0.1.0 — "Born" (2026-07-09)
- Delegatable capability tokens (mint / delegate / verify / revoke with cascade)
- Spend guard: four primitives (per-tx cap, daily budget, destination allowlist, time windows), three presets
- Agent-readable SKILL.md; zero-dependency single file
- The protocol shipped in parallel as a NANDA Town auth plugin, merged into `projnanda/nandatown` main (PR #138)
