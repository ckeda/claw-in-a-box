# Claw Console — demo script (target: 2:55)

Record at a desktop width with the owner ready to tap one fresh Telegram
approval. Clear local Console data before recording, and keep the public repo
open in a second tab.

## 0:00–0:22 — Scope and product

> Claw-in-a-Box was already my live x402 authorization service before this
> event. My Developer Tools submission is Claw Console: an operator console,
> plus the post-baseline security and persistence hardening I built with Codex
> and GPT-5.6. The existing service is production infrastructure, not work I am
> claiming for Build Week. The Console uses that real API—no mocked backend and
> no privileged key.

Show Dashboard. Point to version, both payment-rail readiness flags, heap, and
the two marketplace links.

## 0:22–1:02 — A real human approval

Open Verdict Lab. Keep the generated `console-` agent ID, standard policy, and
amount `150`.

> The standard policy allows up to 200 per transaction, but anything over 100
> needs a human. The response explains the exact rule that fired.

Click **Get verdict**. The Console automatically opens Approvals.

> This is not a fake animation. The owner’s real phone just buzzed. The Console
> polls politely every three seconds while the API waits for the decision.

Show the Telegram message and tap **Approve**. Return to the timeline as it
changes to `approved` and the final verdict becomes `allow`.

## 1:02–1:56 — Authority that only shrinks

Open Token Workbench and mint a root with `read, write, pay`. Delegate a child
with only `read`, then delegate a grandchild. Verify the leaf.

> These are macaroon-style HMAC chains. Every hop can only lose scopes, shorten
> its lifetime, and bind to one audience. The browser decodes the shape for
> visualization, but the API performs the real cryptographic verification.

Revoke the root and accept the confirmation.

> One revocation kills the entire subtree. The Console re-verifies each held
> descendant, and every node flips to `revoked_ancestor`.

## 1:56–2:18 — Operator setup

Briefly show Policies, then Telegram Binding.

> The presets come directly from the live API. An operator can also request a
> 15-minute code, send `/bind CODE` to the bot, and route future review requests
> to their own phone.

## 2:18–2:55 — Where Codex accelerated the build

Switch to the public repository and show `console/src/api.ts`,
`console/src/token.ts`, and the tests.

> I used Codex with GPT-5.6 for the Console core build. Codex accelerated
> translating the frozen API contract into a typed client, implementing the six
> views and delegation tree, generating tests, and running static-build, live
> API, desktop, mobile, Node 18, and Node 22 verification. I made the key
> security decisions: this stays a static no-secret client, paid routes are
> blocked by an exhaustive allowlist before fetch, decoded tokens remain
> untrusted until server verification, and approval polling never becomes an
> API hammer. The `/feedback` session covering that core work is [PASTE EXACT
> CORE-BUILD SESSION ID].

End on Dashboard:

> Claw-in-a-Box: your agent asks before it spends.
