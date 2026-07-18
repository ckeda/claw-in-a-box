# Claw Console

Claw Console is the browser-only operator workbench for
[Claw-in-a-Box](https://clawinabox.xyz), the human-approval layer for AI agent
commerce. It turns the existing public authorization API into a visual,
judge-testable product without adding a backend, account system, privileged
key, or paid call.

The Console is a static React/TypeScript SPA. Its default API is fixed to
`https://api.clawinabox.xyz`, and its request adapter permits only the public
v0.7.5 free endpoints. Attempts to use `/paid/*`, `/paid-okx/*`, unknown paths,
or the wrong HTTP method fail in the browser before `fetch` can run.

## What judges can try

- **Dashboard:** live version, payment readiness flags, heap, bounded collection sizes, uptime, and marketplace receipts from `GET /healthz`.
- **Verdict Lab:** preset or validated inline policies, fired-rule explanations, locally stored history, and one-click reloading.
- **Approvals:** a live timeline that polls no faster than once every three seconds and backs off on `429`.
- **Token Workbench:** mint, delegate children and grandchildren, decode locally, verify with an optional presenter, and animate cascading revocation.
- **Telegram Binding:** generate a 15-minute bind code, copy `/bind CODE`, and verify whether reviews route to the caller or service operator.
- **Policies:** render the live presets as readable cards and open editable copies in Verdict Lab.

### Judge mode

The app is intentionally public and frictionless. A standard-policy guard check
above `100` returns `review`, sends a real Telegram notification to the service
operator, and opens the Approval timeline; the request expires after roughly
120 seconds if the human does not decide.

Console-generated agent IDs begin with `console-` so those notifications and
spend rows are recognizable. Repeated development checks should use an amount
of `30` to receive `allow` without buzzing the operator.

## Local setup

Node.js 18 or newer is supported.

```bash
cd console
npm ci
npm test
npm run build
npm run dev
```

The deployable site is emitted to `dist/`. Navigation uses URL hashes, so the
build works on basic static hosting without server-side rewrite rules.

## Architecture and safety

```text
src/api.ts                 endpoint and method allowlist; paid-route hard block
src/policy.ts              client-side inline-policy validation
src/token.ts               local base64url decode and delegation-tree assembly
src/storage.ts             bounded localStorage helpers
src/pages/Dashboard.tsx    polite 10-second health polling
src/pages/VerdictLab.tsx   guard playground and local history
src/pages/Approvals.tsx    ≥3-second approval polling with 429 backoff
src/pages/TokenWorkbench.tsx
src/pages/TelegramBinding.tsx
src/pages/Policies.tsx
```

Browser storage holds only this device's preferences, the last 30 verdicts, and
up to 30 capability tokens. Tokens are authority: use the reset control on a
shared device. A decoded token is always labelled untrusted until the API
verifies its signature, expiry, attenuation chain, audience, and revocation
state.

The Console never treats a hidden control as enforcement. Phase 0 has no login
because it exposes only capabilities already available through the public free
API; later owner/operator tiers must be enforced by server-side credentials.

## Built with Codex

Codex accelerated four parts of the core build:

1. It translated the frozen v0.7.5 API contract into a typed client with a
   negative allowlist test proving paid routes cannot reach `fetch`.
2. It implemented client-side token decoding, tree reconstruction, descendant
   discovery, and the animated revoke cascade while preserving the warning that
   decode is not verification.
3. It carried the existing Claw-in-a-Box design language into a responsive
   six-view SPA and checked the result at desktop and 390px mobile widths.
4. It generated and ran unit, production-build, live-free-API, Node 18, and
   Node 22 verification passes, then converted the results into an operator
   handoff and demo script.

The owner selected GPT-5.6 for the Build Week session. Before submission, copy
the exact model label and core-build session ID displayed by Codex `/feedback`
into the submission form; do not infer or invent either value.

## Deployment boundary

This repository does not authorize an API deployment. The Console build is
static and may be uploaded to a temporary judging URL or, later,
`console.clawinabox.xyz`. Mainnet API promotion remains on its independent
staging, shadow-observation, and live-verification cadence.

See [`DEPLOY-CHECKLIST.md`](DEPLOY-CHECKLIST.md) and
[`DEMO-SCRIPT.md`](DEMO-SCRIPT.md) for the human handoff.
