# Console static-publication checklist

The human publishes this site. Do not deploy or restart the API service as part
of this checklist.

## Build gate

- [ ] `cd console && npm ci`
- [ ] `npm audit` reports zero vulnerabilities
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] Inspect `dist/`: static HTML, CSS, JavaScript, logo, and favicon only
- [ ] Confirm no `.env`, secret, token fixture, wallet key, or server credential is present

## Static host

- [ ] Create/select a **static site**, not a Node Web App
- [ ] Upload the contents of `console/dist/`
- [ ] Use the temporary host URL for judging; no new domain purchase is required
- [ ] HTTPS is enabled
- [ ] Do not add API keys or runtime environment variables

Hash navigation requires no rewrite configuration. Loading `index.html` and
then visiting `#dashboard`, `#verdict`, `#approvals`, `#tokens`, `#telegram`,
and `#policies` must work.

## Live acceptance

- [ ] Dashboard loads production `/healthz` and shows both rail-ready flags
- [ ] Policies renders three live presets
- [ ] Verdict Lab amount `30` returns `allow` with a `console-` agent ID
- [ ] One coordinated amount `150` test reaches Telegram, then resolves in Approvals
- [ ] Root → child → grandchild delegation renders correctly
- [ ] Revoking the root flips all held descendants to `revoked`
- [ ] Telegram helper generates an eight-character code and verifies routing
- [ ] Mobile width has no horizontal page overflow and all inputs are at least 16px
- [ ] Browser console has no errors
- [ ] Network inspection shows only the declared free API endpoints; no request begins with `/paid`

## Build Week submission

- [ ] Public repository contains `console/` and this documentation
- [ ] Live judge-testable static URL
- [ ] Category: Developer Tools
- [ ] Submission is described as “an operator console + security/persistence hardening I built with Codex for my already-live x402 service”
- [ ] README and form state that v0.7.5 mainnet plus the v0.8.0 staging baseline are pre-existing infrastructure, not Build Week work
- [ ] Only v0.8.1+ increments actually authored in the recorded session are claimed
- [ ] README names where Codex accelerated implementation and where the owner made key product/security decisions
- [x] Codex `/feedback` core-build session recorded: `019f75a2-5efc-70e1-818e-2514176abc6a`
- [x] Confirmed that session covers the majority of the Console's core functionality, not only docs or polish
- [x] Cross-checked the session against the public history beginning with core-build commit `12e479d`
- [ ] Confirm the exact GPT-5.6 model label shown by Codex before recording
- [ ] Record the under-three-minute script in `DEMO-SCRIPT.md`
- [ ] Video audio specifically names Codex-accelerated work, owner decisions, GPT-5.6, and the core-build session ID—never generic “built with AI” wording
- [ ] Public YouTube URL works without sign-in

## Explicitly out of scope

- Mainnet v0.8 promotion
- Shortening the persistence shadow-observation window
- New API endpoints
- Paid-route calls from the Console
- DNS changes to `api.clawinabox.xyz` or `okx.clawinabox.xyz`
