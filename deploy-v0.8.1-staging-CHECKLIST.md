# v0.8.1 permanent staging checklist — test.clawinabox.xyz

This checklist is only for the owner-operated permanent staging environment at
`https://test.clawinabox.xyz` (v0.8.1 through v1.1.0). It does not authorize a
production deploy, merge, tag, marketplace change, or mainnet promotion.

## 1. Artifact and rollback preflight

- [ ] Confirm the draft PR tracks `agent/v0.8.1` and the artifact was built
  from its reviewed head commit.
- [ ] Record the SHA-256 of `deploy-v0.8.1-staging.zip`.
- [ ] Back up the current `test.clawinabox.xyz` service directory, host-managed
  environment, and staging database to a dated rollback location.
- [ ] Inspect the zip before extraction. It must contain service sources,
  lockfile, docs, and tests; it must not contain `.env`, credentials, database
  dumps, `node_modules`, `.git`, or `console/`.
- [ ] In the extracted `service/`, run `npm ci && npm test` on Node 18 and
  Node 22. Confirm the original 38 checks and all v0.8.1 checks pass. Confirm
  `npm ls jose --all` resolves through the v5 override.

## 2. Permanent staging environment

Use host-managed secrets only. The values below are requirements, not an env
file to commit:

| variable | permanent staging value / rule |
|---|---|
| `API_HOST` | `test.clawinabox.xyz` |
| `DISCOVERY` | `off` — mandatory on staging |
| `PERSISTENCE` | `on` — required for claim, rotate, and strict mode |
| `DB_HOST`, `DB_PORT` | staging MySQL only |
| `DB_NAME` | a separate staging database; never the mainnet database |
| `DB_USER`, `DB_PASSWORD` | staging-only credentials with access only to that database |
| `TELEGRAM_BOT_TOKEN` | the staging Telegram test bot, never the production bot |
| `TELEGRAM_CHAT_ID` | the staging test chat |
| `TELEGRAM_WEBHOOK_SECRET` | a staging-only random secret |
| `PAYMENT_MODE` | `okx-x402` so the `/paid-okx` mirror is testable |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | staging CDP credentials |
| `CDP_PAY_TO` | the approved staging recipient |
| `CDP_X402_NETWORK` | `eip155:8453` unless the owner explicitly changes the staging rail |
| `VERDICT_TTL_S` | `300` |
| `EVENT_LIMIT` | `100000` |
| `GUARD_SECRET` | staging-only; never copy mainnet's value |

- [ ] Point the staging Telegram test bot webhook to
  `https://test.clawinabox.xyz/telegram/webhook` using the staging webhook
  secret.
- [ ] Start only the `test.clawinabox.xyz` process. Do not change DNS,
  marketplace listings, production processes, or mainnet configuration.
- [ ] Confirm the startup migration creates/retains the v0.8 tables plus
  `agents`, `verdicts`, and `events` in the separate staging database.

## 3. Discovery-off gate — before any CDP real settlement

Set the common command target:

```bash
export BASE=https://test.clawinabox.xyz
```

- [ ] Verify health before payment testing:

```bash
curl -sS "$BASE/healthz" | jq '{
  version,
  api_host: .features.api_host,
  discovery: .features.cdp_discovery_enabled,
  persistence: .features.persistence,
  cdp_ready: .features.cdp_x402_ready,
  mismatch_count: .counters.claim_payer_mismatch
}'
```

  Expected: version `0.8.1`, `api_host=test.clawinabox.xyz`,
  `discovery=false`, persistence mode `on`, `db_connected=true`,
  `hydrated=true`, CDP ready, and mismatch count `0`.

- [ ] Request a CDP challenge without settling:

```bash
curl -si -X POST "$BASE/paid/v1/guard/check" \
  -H 'content-type: application/json' \
  -d '{"agent_id":"staging-discovery-probe","amount":1}'
```

  Expected: HTTP 402 with a base64 `PAYMENT-REQUIRED` header. Decode that
  header locally and confirm `x402Version:2`, a valid Base/USDC `accepts`
  entry, and no `bazaar` key or other discovery declaration.

- [ ] Do not perform a real settlement through `/paid/*` until both health
  and the decoded 402 prove `DISCOVERY=off`. Bazaar indexes on first CDP
  settlement when discovery is attached.
- [ ] Until that gate is verified, prefer
  `https://test.clawinabox.xyz/paid-okx/*` for real-settle staging E2E.
  Mainnet keeps the default `DISCOVERY=on`.

## 4. Pay-to-Claim and authenticated identity

- [ ] Using the staging buyer flow, perform the first real $0.01 claim through
  `POST $BASE/paid-okx/v1/agents/claim` with a unique staging id. Expect 201
  with `agent_id`, one-time `agent_secret`, `claimed_at`, and
  `claimed_by`. Save the secret only in a secure scratch location.
- [ ] Repeat the same claim. Expect `409 already_claimed` and no second
  settlement.
- [ ] After the discovery-off gate passes, repeat with a fresh id through
  `POST $BASE/paid/v1/agents/claim` to exercise CDP/Base.
- [ ] Confirm claimed operator registration rejects missing/wrong secrets and
  accepts the current secret:

```bash
curl -sS -X POST "$BASE/v1/operators/register" \
  -H 'content-type: application/json' \
  -H "X-Agent-Secret: $AGENT_SECRET" \
  -d '{"agent_id":"staging-v081-owner"}'
```

- [ ] Send the returned `/bind CODE` to the staging Telegram test bot and
  confirm reviews arrive only in the staging test chat.
- [ ] Rotate through `POST $BASE/v1/agents/rotate`; confirm the old secret
  immediately fails and the replacement survives a staging restart.
- [ ] Confirm an unclaimed id still follows the byte-compatible legacy
  operator-registration flow without a secret.

## 5. Strict mode

- [ ] A wrong secret must return 403:

```bash
curl -sS -X POST "$BASE/v1/agents/strict" \
  -H 'content-type: application/json' \
  -H 'X-Agent-Secret: wrong' \
  -d '{"agent_id":"staging-v081-owner","strict":true}'
```

- [ ] Repeat with `$AGENT_SECRET`; expect
  `{"agent_id":"staging-v081-owner","strict_mode":true}`.
- [ ] On `POST $BASE/v1/guard/check`, missing/wrong/correct secret returns
  403/403/200 for that strict id.
- [ ] On the paid rail, a missing secret returns 403 before settlement; the
  correct header reaches normal verdict and settlement.
- [ ] Toggle `strict:false`, confirm open behavior, toggle back on, restart
  staging, and confirm the flag survives.
- [ ] A different unclaimed/non-strict agent remains unaffected.

## 6. Execution binding and audit

- [ ] An ordinary `POST $BASE/v1/guard/check` without `bind` keeps the v0.8
  response shape.
- [ ] A bound allow returns `verdict_id` and `expires_in_seconds:300`:

```bash
curl -sS -X POST "$BASE/v1/guard/check" \
  -H 'content-type: application/json' \
  -d '{"agent_id":"staging-bound","amount":1,"bind":true}'
```

- [ ] `POST $BASE/v1/verdicts/{id}/consume` returns 200 once and then
  `409 already_consumed` with the original time.
- [ ] Send a `bind:true` review, approve it with the staging Telegram test
  bot, and confirm no verdict id exists before approval and a consumable id
  exists afterward.
- [ ] Confirm human approval remains final if the ledger changes while review
  is pending; subsequent automated verdicts see the resulting higher total.
- [ ] Let a fresh bound allow expire. Consume returns 404 and the same-day
  ledger charge is refunded.
- [ ] Inspect staging `events` for:
  `agent_claimed`, `binding_changed`, `approval_created`,
  `approval_resolved`, `verdict_issued`, `verdict_consumed`,
  `verdict_expired`, and `token_revoked`. Exercise
  `claim_payer_mismatch` only with a controlled test facilitator.
- [ ] Confirm event payloads contain no plaintext agent secret or environment
  credential.

## 7. Restart-survival acceptance quad

Prepare all four states on `https://test.clawinabox.xyz` before one restart:

1. mint and revoke a token, retaining it for verification;
2. allow a spend and record `spent_today_after`;
3. create a staging Telegram review and leave it pending;
4. issue a `bind:true` allow and retain its unconsumed `verdict_id`.

- [ ] Restart the staging process once.
- [ ] The revoked token still returns `403 revoked_ancestor`.
- [ ] A follow-up spend increments from the pre-restart daily total.
- [ ] `GET $BASE/v1/approvals/{id}` returns the same pending approval and its
  expiry resumes with only the remaining time.
- [ ] Consume the pre-restart verdict id successfully, then confirm the second
  consume returns 409.
- [ ] Separately let a bound verdict expire during downtime. On the next boot,
  the first sweep makes consume return 404 and refunds its same-day charge.

All four primary states must pass together. Any failure blocks acceptance.

## 8. Rollback and checkpoint

- [ ] On failure, restore the previous staging directory and host-managed
  environment, restore the separate staging database backup when necessary,
  and restart only `test.clawinabox.xyz`.
- [ ] Preserve claimed rows for investigation; do not silently discard paid
  identities.
- [ ] Attach health output, sanitized decoded-402 evidence, Node 18/22 logs,
  payment receipts, staging Telegram evidence, restart-quad evidence, and
  sanitized audit queries to the draft PR.
- [ ] Stop. The owner performs independent v0.8.1 re-review. Do not merge,
  deploy mainnet, tag a release, or begin v0.9.0.
