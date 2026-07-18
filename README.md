# Claw-in-a-Box 🦞📦

**Bounded authorization for AI agents.** Your agent is the claw — it can
grab, spend, and act. Claw-in-a-Box is the box: it limits what the claw can
reach, how much it can spend, and for how long, with a human pull cord for
high-risk actions.

Claw-in-a-Box is the human-approval layer for AI agent commerce. It combines
deterministic spend-policy verdicts, attenuating capability tokens, Telegram
human-in-the-loop approvals, and two production x402 payment rails in one API.

Project home: **https://clawinabox.xyz** · Live API:
**https://api.clawinabox.xyz** ([`/healthz`](https://api.clawinabox.xyz/healthz))
· Agent-facing API reference: [`service/SKILL.md`](service/SKILL.md)
([live copy](https://api.clawinabox.xyz/skill.md))

Marketplace listings:

- [ClawGuard on OKX.AI](https://www.okx.ai/agents/5854) — USDT0 on X Layer through the official OKX x402 SDK
- [Claw-in-a-Box on Agentic.Market](https://agentic.market/services/api-clawinabox-xyz) — USDC on Base through the Coinbase/x402 Bazaar rail

The repository baseline is v0.8.0 staging; the live mainnet service remains on
its independently verified v0.7.5 deployment until the persistence rollout
completes its staging, shadow, and observation gates.

## What it does

### Spend-policy verdicts

Before spending, an agent calls `POST /v1/guard/check` with an amount,
destination, and either a preset or inline policy. The service returns
`allow`, `review`, or `deny`, plus the exact rules and reasons that fired.

The policy engine supports per-transaction caps, daily cumulative budgets,
destination allowlists, human-review thresholds, and time windows. The free
route is part of the public NANDA contract and never requires payment.

### Telegram human approval

A `review` verdict creates a short-lived approval and sends Approve/Deny
buttons to a human in Telegram. Callers can poll the approval or wait for its
resolution, and operators can bind their own Telegram chat through a one-time
`/bind CODE` flow.

### Delegatable capability tokens

An agent can mint a root token and delegate narrower children or grandchildren.
Every hop can only reduce scopes, shorten lifetime, and bind to one audience.
Revoking an ancestor invalidates its entire descendant tree.

### Paid x402 mirrors

The same authorization engine is available for $0.01 per delivered call on two
payment rails:

- `/paid-okx/*` uses the OKX x402 envelope and X Layer/USDT0.
- `/paid/*` on `api.clawinabox.xyz` uses Base/USDC and publishes Bazaar discovery metadata.

Free `/v1/*` endpoints remain outside both payment middlewares. Business
failures are checked before settlement so callers are not charged for rejected
requests.

### Restart-safe persistence

v0.8.0 adds an optional MySQL layer with three rollout modes:

- `PERSISTENCE=off` — v0.7 behavior; no database path is loaded.
- `PERSISTENCE=shadow` — memory stays authoritative while mutations are dual-written asynchronously.
- `PERSISTENCE=on` — shadow writes plus boot-time hydration of revocations, daily spend, operator bindings, and pending approvals.

Database failures degrade to in-memory operation and appear in `/healthz`;
they do not block ordinary requests. Multi-replica coordination is not yet a
guarantee because memory remains the runtime source of truth.

## Quickstart

Call the hosted free API without an account:

```bash
BASE=https://api.clawinabox.xyz

curl -s -X POST "$BASE/v1/guard/check" \
  -d '{"agent_id":"my-agent","amount":30}'

ROOT=$(curl -s -X POST "$BASE/v1/tokens" \
  -d '{"subject":"boss","scopes":["read","write","pay"]}' | jq -r .token)

curl -s -X POST "$BASE/v1/tokens/delegate" \
  -d "{\"parent_token\":\"$ROOT\",\"audience\":\"worker\",\"scopes\":[\"read\"],\"ttl_seconds\":600}"
```

Full endpoint shapes, policy schemas, error codes, payment behavior, and
recommended agent patterns are documented in [`service/SKILL.md`](service/SKILL.md).

## One idea, three enforcement surfaces

The design thesis of this project is that *bounded authorization* — a grant
that can only shrink as it moves, and dies with its ancestors — is one
abstraction that should be enforced wherever an agent acts, at whatever
guarantee strength that surface supports:

| surface | instance | guarantee grade |
|---|---|---|
| HTTP service | this repo's token + guard API | gateway-enforced |
| agent-protocol simulation | [NANDA Town](https://github.com/projnanda/nandatown) `auth: delegatable` plugin ([`plugins/nandatown/`](plugins/nandatown/)) | gateway-enforced, adversarially validated |
| on-chain smart accounts | session-key constraint compiler (roadmap) | protocol-enforced |

The same policy primitives can be carried across these surfaces; what changes
is who enforces them. That distinction is spelled out honestly in
[`docs/guarantees.md`](docs/guarantees.md): a gateway can refuse to bless an
action, but only a protocol can make the action impossible.

## Repository history and layout

Production service sources live in `service/`; `plugins/nandatown/` contains
the NANDA protocol integration, `docs/` records guarantee boundaries, and the
browser Console will live in `console/`. Versions v0.2.0–v0.7.5 shipped as
reviewed deployment artifacts during a rapid NANDA → OKX.AI → x402 Bazaar
sprint rather than as repository commits; their release history and the return
to this repository at v0.8.0 are recorded in [`CHANGELOG.md`](CHANGELOG.md).

```text
service/
  server.js           production HTTP service
  storage.js          optional MySQL persistence
  landing.js          API landing page template
  status.js           status page and probes
  SKILL.md            agent-facing API documentation
  test-v2.js          38-case baseline suite across six boot modes
  package.json        deployable service manifest
  package-lock.json   locked Node 18-compatible dependency graph
plugins/nandatown/    NANDA auth plugin, validators, scenario, and tests
docs/guarantees.md    enforcement guarantees and honest boundaries
CHANGELOG.md          release history, including artifact-only versions
console/              static operator Console (introduced in v0.9.0)
```

## Self-hosting and tests

Node.js 18 or newer is required. The production dependency graph deliberately
pins `jose` v5 through `overrides` for Node 18 CommonJS compatibility.

```bash
cd service
npm ci
GUARD_SECRET=$(openssl rand -hex 32) PORT=8787 npm start
```

Persistence is off by default. To enable it, configure `DB_HOST`, `DB_PORT`,
`DB_USER`, `DB_PASSWORD`, and `DB_NAME`, then select `PERSISTENCE=shadow` or
`PERSISTENCE=on` according to the rollout plan.

Run the complete local suite from `service/`:

```bash
npm test
```

The release gate runs the suite on Node 18 and Node 22. Server deployment also
requires staging acceptance and live invariant verification; a passing local
suite is necessary but never sufficient for mainnet promotion.

## Roadmap

- **v0.8.1 — Locks:** Pay-to-Claim identity, strict mode, execution-bound verdicts, and audit events
- **v0.9.0 — Face:** static operator Console and authenticated read APIs
- **v1.0.0 — Promise:** frozen `/v1` contract, public guarantees, and deprecation policy
- **v1.1.0 — Probe:** trading-policy and MCP discovery experiments with written kill criteria

See [`CHANGELOG.md`](CHANGELOG.md) for shipped changes and version dates.

## License

Apache-2.0.
