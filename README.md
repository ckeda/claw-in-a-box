# Claw-in-a-Box 🦞📦

**Bounded authorization for AI agents.** Your agent is the claw — it can
grab, spend, act. Claw-in-a-Box is the box: hard limits on what the claw
can reach, how much it can hold, and for how long — with one pull cord
that retracts everything it ever handed out.

Two capabilities, one tiny zero-dependency service:

1. **Delegatable capability tokens with cascading revocation** — an agent
   holding a token can mint *narrower* tokens for other agents offline
   (macaroon-style HMAC chaining). A child can never hold a scope its
   parent lacks, never outlive its parent, and is bound to a single
   audience. Revoke any token and every descendant dies with it, by
   construction.
2. **Spend-policy verdicts** — before acting, an agent asks
   `POST /v1/guard/check` and gets back `allow | review | deny` with the
   exact rules that fired. Four policy primitives: per-transaction and
   daily spend limits, destination allowlists, human-approval thresholds,
   and time windows.

```bash
# the whole deployment story
GUARD_SECRET=$(openssl rand -hex 32) node service/server.js
```

Project home: **https://clawinabox.xyz** · Live API:
**https://api.clawinabox.xyz** ([`/healthz`](https://api.clawinabox.xyz/healthz))
· Agent-facing API doc: [`service/SKILL.md`](service/SKILL.md)
(also served at [`/skill.md`](https://api.clawinabox.xyz/skill.md)).

## Why

Agents increasingly hire other agents, call paid APIs, and move money.
The prevailing pattern — hand the sub-agent your full credentials and
hope — fails in three familiar ways: scope creep (the helper ends up
with more power than the task needs), zombie access (nobody remembers
what was handed out, so nothing gets cleanly withdrawn), and confused
deputies (a token leaks and whoever holds it is believed).

Claw-in-a-Box makes the safe pattern the easy pattern:

- **Attenuate, don't share.** Delegation is one HTTP call and needs no
  round-trip to the original issuer. Every hop can only narrow.
- **Revoke once, kill the tree.** Cascading revocation is cryptographic
  (each child's signature is keyed by its parent's), not bookkeeping.
- **Ask before you act.** The spend guard turns "should my agent do
  this?" into a deterministic verdict an agent can be instructed to obey
  — including `review`, an explicit hand-off point to a human.

## Quickstart (60 seconds)

```bash
BASE=https://api.clawinabox.xyz

# a verdict before spending
curl -s -X POST $BASE/v1/guard/check \
  -d '{"agent_id":"my-agent","amount":150}'
# -> {"verdict":"review","triggered_rules":["require_approval"],...}

# mint a root capability, delegate a narrower one, revoke the tree
ROOT=$(curl -s -X POST $BASE/v1/tokens \
  -d '{"subject":"boss","scopes":["read","write","pay"]}' | jq -r .token)
curl -s -X POST $BASE/v1/tokens/delegate \
  -d "{\"parent_token\":\"$ROOT\",\"audience\":\"worker\",\"scopes\":[\"read\"],\"ttl_seconds\":600}"
curl -s -X POST $BASE/v1/tokens/revoke -d "{\"token\":\"$ROOT\"}"
```

Full endpoint reference, error codes, policy schema, and recommended
agent patterns: [`service/SKILL.md`](service/SKILL.md).

## One idea, three enforcement surfaces

The design thesis of this project is that *bounded authorization* — a
grant that can only shrink as it moves, and dies with its ancestors —
is one abstraction that should be enforced wherever an agent acts, at
whatever guarantee strength that surface supports:

| surface | instance | guarantee grade |
|---|---|---|
| HTTP service | this repo's token + guard API | gateway-enforced |
| agent-protocol simulation | [NANDA Town](https://github.com/projnanda/nandatown) `auth: delegatable` plugin ([`plugins/nandatown/`](plugins/nandatown/)) | gateway-enforced, adversarially validated |
| on-chain smart accounts | session-key constraint compiler (roadmap) | protocol-enforced |

The same four policy primitives compile to each surface; what changes is
who enforces them. That distinction is spelled out honestly in
[`docs/guarantees.md`](docs/guarantees.md) — a gateway can refuse to
bless an action, but only a protocol can make the action impossible.

## Repository layout

```
service/              zero-dependency Node.js service (node >= 18)
  server.js           the entire service
  SKILL.md            agent-facing API documentation (served at /skill.md)
  test.js             12-case smoke suite: node test.js
  demo.sh             narrated terminal walkthrough for screen-recording
plugins/nandatown/    Python implementation of the same protocol as a
                      NANDA Town auth-layer plugin, with adversarial
                      validators and a delegation-tree scenario
docs/guarantees.md    what is guaranteed, by whom, and what is not
```

## Self-hosting

```bash
cd service
GUARD_SECRET=$(openssl rand -hex 32) PORT=8787 node server.js
node test.js    # exits 0 on green
```

No npm install. State (revocations, daily totals) is in-memory by
design at this stage — see `docs/guarantees.md` before pointing
production funds at it.

## Roadmap

- Persistent revocation and spend state (SQLite)
- Webhook / Telegram hand-off for `review` verdicts (human-in-the-loop)
- Policy compiler targeting ERC-4337 session keys and Safe modules —
  the protocol-enforced row of the table above
- x402 pay-per-call support for hosted deployments

## License

Apache-2.0.
