# v0.9.0 permanent staging checklist — test.clawinabox.xyz

Human-operated checklist for `https://test.clawinabox.xyz`. It does not
authorize deployment to mainnet or `console.clawinabox.xyz`, a merge, or a tag.

## 1. Artifact and review gate

- [ ] Draft PR tracks `agent/v0.9.0`; artifact SHA-256 matches the checkpoint report.
- [ ] Inspect the zip: service, Console source, docs, tests, `llms.txt`, and this
  checklist only; no `.env`, secret, database dump, `.git`, `node_modules`, or
  built Console containing a credential.
- [ ] Run `service/test-all.js` independently on Node 18 and Node 22; run the
  Console's 20 tests and production build on both. Confirm `npm ls jose --all`
  stays on jose v5.
- [ ] Back up the staging service directory, environment, and separate database.

## 2. Host-managed environment

Fill secret values only in Hostinger. Never create or upload an env file.

| variable | value to fill / requirement |
|---|---|
| `API_HOST` | `test.clawinabox.xyz` |
| `DISCOVERY` | `off` |
| `PERSISTENCE` | `on` |
| `OPERATOR_BEARER_KEY` | **FILL:** new high-entropy staging-only key |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | **FILL:** separate staging MySQL only |
| `DB_USER`, `DB_PASSWORD` | **FILL:** staging DB-limited credentials |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | **FILL:** staging test bot/chat only |
| `TELEGRAM_WEBHOOK_SECRET` | **FILL:** staging-only random value |
| `GUARD_SECRET` | **FILL:** staging-only random value |
| `PAYMENT_MODE` | `okx-x402` |
| `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` | **FILL:** staging credentials |
| `X402_PAY_TO`, `X402_NETWORK`, `X402_ASSET` | **FILL:** approved staging OKX rail values |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | **FILL:** staging CDP credentials |
| `CDP_PAY_TO`, `CDP_X402_NETWORK` | **FILL:** approved staging Base rail values |
| `RECOVERY_ISSUE_IP_MAX` | optional; default `5` per window |
| `RECOVERY_ISSUE_AGENT_MAX` | optional; default `3` per window |
| `RECOVERY_VERIFY_IP_MAX` | optional; default `10` per window |
| `RECOVERY_RATE_WINDOW_MS` | optional; default `3600000` |
| `RECOVERY_TTL_MS` | optional; default `300000` |
| `SPEND_LEDGER_RETENTION_DAYS` | optional; default `90` |
| `EVENT_LIMIT`, `VERDICT_TTL_S` | retain reviewed staging values |

- [ ] Telegram webhook points only to
  `https://test.clawinabox.xyz/telegram/webhook`.
- [ ] Startup creates `spend_ledger` and `agent_recovery_nonces` without
  damaging v0.8 tables.
- [ ] Do not settle through `/paid/*`. Unpaid 402 probes only; discovery must
  remain off. If a later authorized real-settle E2E is needed, prefer
  `/paid-okx/*` until discovery-off has been independently verified.

## 3. Read-only smoke and contract invariants

```bash
export BASE=https://test.clawinabox.xyz
bash verify-live-v09.sh "$BASE" 0.9.0
curl -sS "$BASE/healthz" | jq '{version, features, memory, counters}'
```

- [ ] Version is `0.9.0`; persistence is `on`, connected, hydrated; recovery
  and operator features are present; payer-mismatch counter remains present.
- [ ] The five NANDA response bodies match the v0.8 snapshots byte-for-byte;
  none returns 402/403 for unclaimed, non-strict callers. Header-only
  `RateLimit-*` additions are acceptable.
- [ ] Both claim GET/POST unpaid probes return well-formed 402 envelopes and
  settle nothing; CDP declarations contain no Bazaar/discovery extension.
- [ ] CORS adds `authorization` only to allow-headers, keeps wildcard origin,
  and does not emit `Access-Control-Allow-Credentials`.

## 4. Access model

```bash
curl -sS "$BASE/v1/metrics" | jq .
curl -si "$BASE/v1/approvals?status=pending&limit=25"
curl -sS "$BASE/v1/approvals?status=pending&limit=25" \
  -H "Authorization: Bearer $OPERATOR_BEARER_KEY" | jq .
curl -sS "$BASE/v1/agents/$AGENT_ID/spend" \
  -H "X-Agent-Secret: $AGENT_SECRET" | jq .
```

- [ ] Metrics is public, aggregate-only, fixed-schema, cached, and contains no
  ids, wallets, destinations, chats, event payloads, or individual amounts.
- [ ] Approval list: missing/wrong key 401, agent secret cannot substitute,
  correct operator key works, status/limit validation is 400, and results are
  limited to the existing approximately 30-minute feed.
- [ ] Spend: unclaimed 404; missing/wrong/cross-agent secret 403; own secret
  works; fixed last-50 rows contain no destination/policy/wallet/chat.
- [ ] Stop the DB temporarily in the controlled window: all three reads and
  recovery return 503; ordinary NANDA use remains available. Restore DB and
  verify hydration before continuing.

## 5. Recovery and retention

- [ ] Use a staging-only claimed EOA. Issue a challenge, verify exact
  `Domain: test.clawinabox.xyz`, sign with EIP-191 `personal_sign`, submit, and
  save the returned secret once. Old secret fails; new secret authenticates.
- [ ] Wrong wallet 403; malformed signature 400; expired nonce 410; replay 409;
  two concurrent submissions yield exactly one success.
- [ ] Issue before restart and submit after restart successfully. A signature
  issued under another `API_HOST` cannot replay.
- [ ] Contract/custodial wallet limitation is visible: manual operator recovery,
  no false EIP-1271 claim.
- [ ] Rate limits enforce 5 issue/hour/IP, 3 issue/hour/agent, and 10
  submissions/hour/IP by default, each with `Retry-After`.
- [ ] Expired nonce sweep removes stale rows; spend-ledger sweep retains only 90
  days. Audit payloads contain no nonce, signature, plaintext secret, raw IP,
  operator key, or full recovery wallet.

## 6. Console repository acceptance — do not publish frozen domain

- [ ] Build with `VITE_API_BASE=https://test.clawinabox.xyz`; inspect source map
  and output for secrets before using a temporary/private staging preview.
- [ ] Operator key exists only in sessionStorage/in-memory and disappears per
  session; it never appears in localStorage, query strings, logs, or rendered JSON.
- [ ] Agent-owner slot may persist in localStorage; masking, per-slot clear, and
  clear-all work. Telegram rebinding sends the matching agent secret.
- [ ] Approval feed, spend history, metrics, strict on/off, and EOA recovery work.
- [ ] Network log contains only allowlisted `/v1` routes; `/paid/*` and
  `/paid-okx/*` are blocked before fetch.
- [ ] Do **not** upload this build to `console.clawinabox.xyz`; judging freeze
  remains until explicit owner approval.

## 7. Rollback and checkpoint

- [ ] On failure, restore only staging service/env/DB backup; preserve evidence
  and any paid claimed identity rows.
- [ ] Attach sanitized Node logs, health, headers, DB-down proof, recovery
  restart/replay proof, Console storage/network evidence, and zip SHA to review.
- [ ] Stop. No merge, tag, mainnet deploy, frozen-Console deploy, or v1.0 work.
