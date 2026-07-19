# OpenAI Build Week video script — under three minutes

Target runtime: **2:52**  
Category: **Developer Tools**  
Required live surfaces: `console.clawinabox.xyz`, the phone running Telegram,
`test.clawinabox.xyz`, and the public GitHub repository.

## 0:00–0:13 — The real problem

**Shot:** Full-screen title, then a fast cut to an agent payment request and the
Claw Console landing view.

**On-screen text:**

> Bounded authorization for AI agents  
> Your agent asks before it spends.

**Voiceover:**

> AI agents can act and pay, but authority should have limits. Claw-in-a-Box is
> the existing service that asks: is this action allowed, denied, or important
> enough for a human decision?

## 0:13–0:29 — Put the authorship boundary on screen

**Shot:** GitHub repository history. Hold on the `v0.8.0` tag, then visually
bracket the Console, v0.8.1, and v0.9 commits above it.

**On-screen text:**

> Pre-existing infrastructure: v0.1–v0.8.0  
> Built with Codex + GPT-5.6: Console + v0.8.1 + v0.9.0

**Voiceover:**

> The service through v0.8.0 existed before Build Week. With Codex and GPT-5.6,
> I built exactly three things on top: this Console, v0.8.1 security locks, and
> the v0.9 operational face—not the earlier backend.

## 0:29–0:55 — Show the Console Codex built

**Shot:** Move through Dashboard, Verdict Lab, Token Workbench, and the token
delegation tree. Briefly revoke a parent and show descendants flip to revoked.

**On-screen text:**

> Static React + TypeScript  
> Paid routes blocked before fetch  
> Decode ≠ verify

**Voiceover:**

> Codex built this static React and TypeScript Console from scratch: telemetry,
> explainable verdicts, approval tracking, Telegram binding, and capability
> trees with cascading revocation. Its typed client rejects paid and unknown
> routes before fetch; local decoding is never called verification.

## 0:55–1:27 — Live human approval loop

**Shot:** In the live Console, enter a recognizable `console-` agent, standard
policy, and amount `150`. Click **Get verdict**. Keep the browser visible as it
opens Approvals and says “A real human’s phone just buzzed.” Cut to the phone;
show the real Telegram request and tap **Approve**. Cut back as the timeline
changes to approved.

**On-screen text:**

> Live Console → existing mainnet API → real Telegram human approval

**Voiceover:**

> Here is the real loop against the existing mainnet API. One hundred and fifty
> crosses the review threshold. The Console opens the timeline—and a human’s
> phone just buzzed. The agent waits. I approve on Telegram, and the verdict
> returns. The UI observes; the service enforces.

## 1:27–1:51 — v0.8.1 security locks

**Shot:** Split screen: Draft PR #2 and concise code/test highlights for
Pay-to-Claim, `X-Agent-Secret`, strict mode, and one-shot verdict consumption.
Show `test.clawinabox.xyz/healthz`, not mainnet deployment controls.

**On-screen text:**

> v0.8.1 “Locks”  
> Pay-to-Claim · strict identity · one-shot verdicts · audit

**Voiceover:**

> Codex then hardened the v0.8 baseline. v0.8.1 adds paid claiming, hashed
> one-time secrets, strict identity, restart-safe execution verdicts, refunds,
> and audit. Security fails closed with 503 unless the database is connected and
> hydrated—never a memory fallback.

## 1:51–2:19 — v0.9 operational face and recovery

**Shot:** Open the repository v0.9 Console Access page, then staging endpoints
on `test.clawinabox.xyz`: aggregate metrics, an authenticated spend response,
and a prepared recovery challenge. Show the recovery transaction lines in
`service/storage.js`: `FOR UPDATE` and `used_at IS NULL`.

**On-screen text:**

> v0.9 “Face” on staging  
> Operator god-view ≠ agent-owner access  
> EIP-191 recovery: lock, verify, consume once

**Voiceover:**

> v0.9 adds an operator approval feed, agent-scoped spend, public metrics, and
> wallet recovery on staging. Codex separated god-view from agent authority.
> Recovery locks nonce and agent rows, verifies the EOA, conditionally consumes
> the nonce, and rotates the secret atomically, so replay races have one winner.

## 2:19–2:40 — Show how Codex worked

**Shot:** Fast sequence: the v0.8.1 design questions, owner verdicts, v0.9 design
note with the session-only operator-key amendment, then terminal test summaries
for Node 18 and Node 22.

**On-screen text:**

> Question → owner adjudication → implementation → independent review  
> Server: 38 + 77 + 43 = 158 checks  
> Console: 20 tests · Node 18 + Node 22

**Voiceover:**

> GPT-5.6 did more than generate UI. Codex raised security ambiguities; the
> owner adjudicated identity, refunds, human finality, payer truth, credential
> storage, and recovery. Codex implemented and tested those decisions: 38
> baseline, 77 v0.8.1, and 43 v0.9 server checks, plus 20 Console tests on Node
> 18 and 22. v0.8.1 passed independent review and staging restart acceptance;
> v0.9 stays Draft until its human gates pass.

## 2:40–2:52 — Honest close

**Shot:** Repository README and Devpost submission page side by side. End on
the Console logo and repository URL.

**On-screen text:**

> Built with Codex + GPT-5.6 on top of an existing v0.8.0 service  
> github.com/ckeda/claw-in-a-box · Devpost: project page

**Voiceover:**

> The existing service is the foundation. Codex and GPT-5.6 built the Console,
> v0.8.1, and v0.9 on top. The code, Draft PRs, tests, and attribution are in
> the repo and on Devpost.

## Recording notes

- Coordinate the amount-150 approval with the phone holder so the live segment
  completes quickly; do not fake the Telegram tap.
- Use the already-live Console for the mainnet approval demo. Do not deploy the
  v0.9 Console to the frozen domain for this recording.
- Use staging only for v0.9 shots. Do not complete a payment or claim while
  recording.
- Keep browser zoom large enough that commit SHAs, test totals, and the
  `test.clawinabox.xyz` hostname are readable.
- If the live approval takes longer than expected, preserve the real chronology
  and trim waiting time with a visible jump cut; do not imply an instant result.
