# v0.8.1 staging deploy checklist

This checklist is for the owner-operated staging host only. It does not
authorize a production deploy, merge, tag, or mainnet promotion.

## 1. Preflight and artifact

- [ ] Confirm the branch/PR is `agent/v0.8.1` and the artifact was produced
  from its reviewed commit.
- [ ] Record the SHA-256 of `deploy-v0.8.1-staging.zip` and copy the current
  staging service directory, environment file, and database backup to a dated
  rollback location.
- [ ] Inspect the zip before extraction. It must contain the service sources,
  lockfile, docs, and tests; it must not contain `.env`, credentials, database
  dumps, `node_modules`, `.git`, or the Console.
- [ ] On both Node 18 and Node 22, run `npm ci` and `npm test` inside the
  extracted `service/` directory. Confirm the original 38 checks and all
  v0.8.1 checks pass. Confirm `npm ls jose` resolves through the v5 override.

## 2. Database and environment

- [ ] Use a staging-only MySQL database and credentials. The startup migration
  creates `agents`, `verdicts`, and `events` while retaining the v0.8 tables.
- [ ] Set `PERSISTENCE=on`. Pay-to-Claim and rotation intentionally return
  `503 feature_disabled` in `off`, `shadow`, disconnected, or unhydrated state.
- [ ] Keep `VERDICT_TTL_S=300` (default) and `EVENT_LIMIT=100000` (default).
- [ ] Keep the existing payment-rail, Telegram, database, and `GUARD_SECRET`
  values in the host-managed environment. Never copy them into the repo or zip.
- [ ] Restart the staging service only. Do not change DNS, marketplace listings,
  production processes, or mainnet configuration.
- [ ] Verify `GET /healthz`: version `0.8.1`, persistence mode `on`,
  `db_connected=true`, `hydrated=true`, and the expected x402 rail(s) ready.

## 3. Pay-to-Claim and authentication

- [ ] On the CDP/Base staging route, complete one real $0.01 claim. Expect 201
  with `agent_id`, one-time `agent_secret`, `claimed_at`, and `claimed_by` equal
  to the payer wallet. Save the secret in a secure scratch location.
- [ ] Repeat the same claim. Expect `409 already_claimed`; verify there is no
  second settlement/charge.
- [ ] Repeat the first-claim check through the `/paid-okx` mirror with a fresh
  staging agent id.
- [ ] For the claimed id, call `/v1/operators/register` with no secret, a wrong
  secret, and the correct `X-Agent-Secret`; expect 403, 403, and 200.
- [ ] Call `/v1/agents/rotate` with the current header. Confirm the old secret
  immediately fails and the replacement succeeds. Restart staging and confirm
  the replacement still succeeds.
- [ ] Confirm an unclaimed id still follows the byte-compatible legacy operator
  registration flow without a secret.

## 4. Strict mode

The design specifies strict behavior but does not define a public toggle
endpoint/body. This candidate therefore persists and enforces the flag without
inventing an HTTP contract. For the staging test, enable it directly:

```sql
UPDATE agents SET strict_mode = TRUE WHERE agent_id = '<staging-agent-id>';
```

- [ ] Restart staging so the strict flag hydrates.
- [ ] Free guard: missing/wrong/correct secret returns 403/403/200.
- [ ] Paid guard: payment without the secret returns 403 and does not settle;
  the same request with the header reaches the normal verdict and settlement.
- [ ] A different unclaimed/non-strict agent remains 200 and never receives an
  identity 403.

## 5. Execution binding and audit

- [ ] Capture the response shape of an ordinary guard call and confirm it has
  no new fields when `bind` is absent.
- [ ] Send an allowed guard with `"bind":true`. Expect `verdict_id` and
  `expires_in_seconds: 300`; first consume returns 200 and second consume
  returns `409 already_consumed` with the original time.
- [ ] Send a review with `"bind":true`, approve it in Telegram, and confirm the
  resolved approval carries a consumable verdict id. No id should be issued
  before approval.
- [ ] Let a fresh bound allow expire unconsumed. Consume must return 404; a
  follow-up guard must show the same-day amount was refunded from the ledger.
- [ ] Inspect `events` for all eight types:
  `agent_claimed`, `binding_changed`, `approval_created`,
  `approval_resolved`, `verdict_issued`, `verdict_consumed`,
  `verdict_expired`, and `token_revoked`.
- [ ] Confirm event payloads contain no plaintext agent secret or environment
  credential. FIFO retention is covered by the local suite at a reduced cap.

## 6. Restart-survival acceptance gate

Prepare all three states before one restart:

1. mint and revoke a token, retaining the token for verification;
2. allow a spend for a stable agent id and record `spent_today_after`;
3. create a Telegram review and leave the approval pending.

- [ ] Restart staging once.
- [ ] The revoked token still returns `403 revoked_ancestor`.
- [ ] A follow-up spend for the same agent increments from the pre-restart
  daily total rather than zero.
- [ ] `GET /v1/approvals/{id}` returns the same pending approval, whose expiry
  timer resumes with only its remaining time.

All three must pass together. Any failure blocks owner acceptance.

## 7. Rollback and checkpoint

- [ ] On failure, restore the previous staging directory and environment, then
  restart staging. The new tables may remain unused. Preserve any claimed rows
  for investigation; do not silently discard identities after a paid claim.
- [ ] Attach health output, test logs, payment receipts, restart-trio evidence,
  and sanitized audit queries to the draft PR.
- [ ] Stop. The owner performs the independent v0.8.1 review. Do not merge,
  deploy mainnet, tag a release, or begin v0.9.0.
