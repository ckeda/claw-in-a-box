# Changelog — Claw-in-a-Box

> Versions v0.2.0–v0.7.5 were shipped as deployment artifacts during a two-week
> hackathon sprint (NANDA Town → OKX AI Genesis → x402 Bazaar) and were not
> pushed to this repository at the time. Development returned to this repo at
> the v0.8.0 baseline. Dates are actual ship dates to production/staging.

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
