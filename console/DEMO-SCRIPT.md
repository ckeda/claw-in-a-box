# Claw Console — demo script (target: 2:40)

Record at a desktop width with the owner ready to tap one fresh Telegram
approval. Clear local Console data before recording, and keep the public repo
open in a second tab.

## 0:00–0:18 — The product

> AI agents are starting to spend real money. Claw-in-a-Box is the bounded
> authorization layer: your agent asks before it spends. This is Claw Console,
> a public, browser-only workbench built against the live API—no mocked backend
> and no privileged key.

Show Dashboard. Point to version, both payment-rail readiness flags, heap, and
the two marketplace links.

## 0:18–0:58 — A real human approval

Open Verdict Lab. Keep the generated `console-` agent ID, standard policy, and
amount `150`.

> The standard policy allows up to 200 per transaction, but anything over 100
> needs a human. The response explains the exact rule that fired.

Click **Get verdict**. The Console automatically opens Approvals.

> This is not a fake animation. The owner’s real phone just buzzed. The Console
> polls politely every three seconds while the API waits for the decision.

Show the Telegram message and tap **Approve**. Return to the timeline as it
changes to `approved` and the final verdict becomes `allow`.

## 0:58–1:52 — Authority that only shrinks

Open Token Workbench and mint a root with `read, write, pay`. Delegate a child
with only `read`, then delegate a grandchild. Verify the leaf.

> These are macaroon-style HMAC chains. Every hop can only lose scopes, shorten
> its lifetime, and bind to one audience. The browser decodes the shape for
> visualization, but the API performs the real cryptographic verification.

Revoke the root and accept the confirmation.

> One revocation kills the entire subtree. The Console re-verifies each held
> descendant, and every node flips to `revoked_ancestor`.

## 1:52–2:16 — Operator setup

Briefly show Policies, then Telegram Binding.

> The presets come directly from the live API. An operator can also request a
> 15-minute code, send `/bind CODE` to the bot, and route future review requests
> to their own phone.

## 2:16–2:40 — How Codex built it

Switch to the public repository and show `console/src/api.ts`,
`console/src/token.ts`, and the tests.

> I built this with Codex using the GPT-5.6 model selected for this session.
> Codex converted the frozen API contract into a typed paid-route safety rail,
> built the interactive delegation tree, matched the existing brand, and ran
> the app through unit, static-build, live API, desktop, mobile, Node 18, and
> Node 22 checks. The core-build session ID is [PASTE `/feedback` SESSION ID].

End on Dashboard:

> Claw-in-a-Box: your agent asks before it spends.
