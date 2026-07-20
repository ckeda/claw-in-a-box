// SPDX-License-Identifier: Apache-2.0
// Claw-in-a-Box — delegatable capability tokens + spend-policy verdicts
// for AI agents. Express + official OKX Payment SDK. Node.js >= 18. See SKILL.md.
//
//   npm install && PORT=8787 GUARD_SECRET=change-me npm start

"use strict";

const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const { LANDING_HTML } = require("./landing");
const { mountStatus } = require("./status");
const persistence = require("./storage");
const fs = require("node:fs");

const PORT = Number(process.env.PORT || 8787);
const SECRET = Buffer.from(process.env.GUARD_SECRET || "claw-in-a-box-dev-secret");
const DEFAULT_TTL_S = 3600;

// ── Telegram HITL (all optional; unset = feature off, behavior unchanged) ──
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const TG_ENABLED = Boolean(TG_TOKEN && TG_CHAT);

// ── Multi-tenant approval routing (v0.4) ──────────────────────────────────
// A caller can bind their own Telegram so THEIR review requests go to THEIR
// phone. agent_id -> chat_id. Unbound agents fall back to the operator chat
// (TG_CHAT), preserving the original single-tenant behavior.
const operatorBindings = new Map(); // agent_id -> chat_id
const pendingBinds = new Map();     // one-time code -> { agent_id, created }
const BIND_TTL_MS = 15 * 60 * 1000; // a bind code is valid for 15 minutes

// v0.8.1 Pay-to-Claim identity cache. This is hydrated from MySQL before the
// hard-DB feature is marked ready. Secrets never enter this map in plaintext.
// agent_id -> { secret_hash, claimed_at, claimed_by, strict_mode }
const claimedAgents = new Map();
const healthCounters = {
  claim_payer_mismatch: 0,
};

const secretHash = (secret) =>
  crypto.createHash("sha256").update(String(secret), "utf8").digest("hex");

function newAgentSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function secretsEqual(presented, expectedHash) {
  const candidate = Buffer.from(secretHash(presented), "hex");
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function payersEqual(verifiedPayer, settlementPayer) {
  const verified = String(verifiedPayer || "").trim();
  const settledPayer = String(settlementPayer || "").trim();
  if (verified.startsWith("0x") && settledPayer.startsWith("0x")) {
    return verified.toLowerCase() === settledPayer.toLowerCase();
  }
  return verified === settledPayer;
}

function requireAgentSecret(req, agentId, { strictOnly = false } = {}) {
  const rawAgentId = String(agentId);
  const claimed = claimedAgents.get(rawAgentId) || claimedAgents.get(rawAgentId.trim());
  if (!claimed || (strictOnly && !claimed.strict_mode)) return claimed;
  const presented = req.get("X-Agent-Secret") || "";
  if (!secretsEqual(presented, claimed.secret_hash)) {
    const error = new Error("a valid X-Agent-Secret is required for this claimed agent_id");
    error.code = "forbidden";
    error.status = 403;
    throw error;
  }
  return claimed;
}

function chatForAgent(agentId) {
  return operatorBindings.get(String(agentId)) || TG_CHAT;
}
function newBindCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 hex chars
}
const APPROVAL_TIMEOUT_S = Number(process.env.APPROVAL_TIMEOUT_S || 120);

// ── x402 pay-per-call (mounted only on /paid/* mirror routes) ──────────────
// PAYMENT_MODE: "off" (default) | "mock-x402" (demo) | "okx-x402" (production)
const PAYMENT_MODE = process.env.PAYMENT_MODE || "off";
const X402 = {
  payTo: process.env.X402_PAY_TO || "",
  network: process.env.X402_NETWORK || "eip155:196", // X Layer
  asset: process.env.X402_ASSET || "0x779ded0c9e1022225f8e0630b35a9b54be713736", // USDT0
  amount: process.env.X402_AMOUNT_MINIMAL || "10000", // 0.01, 6 decimals
  price: process.env.X402_PRICE || "$0.01",
  name: process.env.X402_TOKEN_NAME || "USDt0",
  symbol: process.env.X402_TOKEN_SYMBOL || "USDT0",
  decimals: Number(process.env.X402_TOKEN_DECIMALS || 6),
  // OKX OnchainOS facilitator (base host; paths are /api/v6/pay/x402/*)
  facilitator: (process.env.X402_FACILITATOR_URL || "https://web3.okx.com").replace(/\/$/, ""),
  maxTimeoutSeconds: Number(process.env.X402_MAX_TIMEOUT_S || 600),
};

// OKX API credentials for facilitator verify/settle (HMAC-SHA256 signed).
// Never expose these to buyers or commit them.
const OKX = {
  apiKey: process.env.OKX_API_KEY || "",
  secretKey: process.env.OKX_SECRET_KEY || "",
  passphrase: process.env.OKX_PASSPHRASE || "", // optional on some accounts
};
const OKX_READY = Boolean(OKX.apiKey && OKX.secretKey);

// ---------------------------------------------------------------------------
// Macaroon-style token core (mirror of the NANDA Town `delegatable` plugin)
// ---------------------------------------------------------------------------

const revoked = new Set(); // segment tids

const canonical = (obj) => JSON.stringify(sortKeys(obj));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

const segTid = (seg) =>
  crypto
    .createHash("sha256")
    .update(
      canonical({
        aud: seg.aud,
        scopes: [...seg.scopes].sort(),
        iat: seg.iat,
        exp: seg.exp,
        parent: seg.parent,
      })
    )
    .digest("hex")
    .slice(0, 16);

function chainSig(chain) {
  let key = SECRET;
  for (const seg of chain) {
    key = crypto.createHmac("sha256", key).update(canonical(seg)).digest();
  }
  return key.toString("hex");
}

const encodeToken = (chain) =>
  Buffer.from(JSON.stringify({ chain, sig: chainSig(chain) })).toString("base64url");

function decodeToken(token) {
  let env;
  try {
    env = JSON.parse(Buffer.from(String(token), "base64url").toString());
  } catch {
    throw guardError("invalid_token", "token is not valid base64url JSON");
  }
  if (!env || !Array.isArray(env.chain) || !env.chain.length || typeof env.sig !== "string") {
    throw guardError("invalid_token", "token envelope malformed");
  }
  const expected = chainSig(env.chain);
  const a = Buffer.from(env.sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw guardError("invalid_signature", "signature does not match chain");
  }
  return env.chain;
}

function checkChain(chain, now) {
  let parentScopes = null;
  let parentExp = null;
  for (const seg of chain) {
    if (revoked.has(seg.tid)) {
      throw guardError("revoked_ancestor", `ancestor tid=${seg.tid} revoked`);
    }
    if (seg.exp < now) {
      throw guardError("expired_ancestor", `ancestor tid=${seg.tid} expired`);
    }
    const scopes = new Set(seg.scopes.map(String));
    if (parentScopes && ![...scopes].every((s) => parentScopes.has(s))) {
      const extra = [...scopes].filter((s) => !parentScopes.has(s)).sort();
      throw guardError("scope_escalation", `scopes [${extra}] not held by parent`);
    }
    if (parentExp !== null && seg.exp > parentExp) {
      throw guardError("expired_ancestor", "child exp exceeds parent exp");
    }
    parentScopes = scopes;
    parentExp = seg.exp;
  }
}

function issueRoot(subject, scopes, ttlS) {
  const now = Date.now() / 1000;
  const exp = now + (ttlS || DEFAULT_TTL_S);
  const seg = { aud: subject, scopes: [...scopes].sort(), iat: now, exp, parent: null };
  seg.tid = segTid(seg);
  return encodeToken([seg]);
}

function delegateToken(parentToken, audience, scopes, ttlS) {
  const now = Date.now() / 1000;
  const chain = decodeToken(parentToken);
  checkChain(chain, now);
  const parent = chain[chain.length - 1];
  const parentScopes = new Set(parent.scopes.map(String));
  const requested = [...new Set(scopes.map(String))].sort();
  const extra = requested.filter((s) => !parentScopes.has(s));
  if (extra.length) {
    throw guardError("scope_escalation", `scopes [${extra}] not held by parent`);
  }
  const exp = Math.min(now + (ttlS || DEFAULT_TTL_S), parent.exp);
  const seg = { aud: audience, scopes: requested, iat: now, exp, parent: parent.tid };
  seg.tid = segTid(seg);
  return encodeToken([...chain, seg]);
}

function verifyToken(token, presenter) {
  const now = Date.now() / 1000;
  const chain = decodeToken(token);
  checkChain(chain, now);
  const leaf = chain[chain.length - 1];
  if (presenter && presenter !== leaf.aud) {
    throw guardError("audience_mismatch", `presented by ${presenter}, bound to ${leaf.aud}`);
  }
  return {
    subject: leaf.aud,
    scopes: leaf.scopes,
    issued_at: leaf.iat,
    expires_at: leaf.exp,
    chain_tids: chain.map((s) => s.tid),
    depth: chain.length,
  };
}

function revokeToken(token) {
  const chain = decodeToken(token);
  const leaf = chain[chain.length - 1];
  revoked.add(leaf.tid);
  persistence.saveRevoked(leaf.tid);
  persistence.audit("token_revoked", leaf.aud, leaf.tid, { cascades: true });
  return { revoked_tid: leaf.tid, cascades: true };
}

// ---------------------------------------------------------------------------
// Spend-policy verdicts (four primitives; presets need zero configuration)
// ---------------------------------------------------------------------------

const PRESETS = {
  conservative: {
    name: "conservative",
    rules: [
      { type: "spend_limit", per_tx: 50, daily: 200 },
      { type: "require_approval", when_amount_over: 20 },
      { type: "allowlist", field: "destination", values: [], mode: "off" },
    ],
  },
  standard: {
    name: "standard",
    rules: [
      { type: "spend_limit", per_tx: 200, daily: 1000 },
      { type: "require_approval", when_amount_over: 100 },
      { type: "allowlist", field: "destination", values: [], mode: "off" },
    ],
  },
  permissive: {
    name: "permissive",
    rules: [
      { type: "spend_limit", per_tx: 1000, daily: 5000 },
      { type: "require_approval", when_amount_over: 500 },
    ],
  },
};

// agent_id -> { day: "YYYY-MM-DD", spent: number }  (in-memory, resets daily)
const dailySpend = new Map();
const verdicts = new Map();
const VERDICT_TTL_S = Number(process.env.VERDICT_TTL_S || 300);

function guardCheck(body) {
  const agentId = String(body.agent_id || "anonymous");
  const amount = Number(body.amount || 0);
  const destination = body.destination ? String(body.destination) : null;
  const policy =
    body.policy && typeof body.policy === "object"
      ? body.policy
      : PRESETS[String(body.policy || "standard")] || PRESETS.standard;

  const day = new Date().toISOString().slice(0, 10);
  const entry = dailySpend.get(agentId);
  const spentToday = entry && entry.day === day ? entry.spent : 0;

  const triggered = [];
  const reasons = [];
  let verdict = "allow";
  const deny = (rule, reason) => {
    verdict = "deny";
    triggered.push(rule);
    reasons.push(reason);
  };
  const review = (rule, reason) => {
    if (verdict !== "deny") verdict = "review";
    triggered.push(rule);
    reasons.push(reason);
  };

  for (const rule of policy.rules || []) {
    if (rule.type === "spend_limit") {
      if (rule.per_tx != null && amount > rule.per_tx) {
        deny("spend_limit.per_tx", `amount ${amount} exceeds per-tx limit ${rule.per_tx}`);
      }
      if (rule.daily != null && spentToday + amount > rule.daily) {
        deny(
          "spend_limit.daily",
          `daily total ${spentToday + amount} would exceed limit ${rule.daily}`
        );
      }
    } else if (rule.type === "allowlist" && rule.mode !== "off") {
      const values = (rule.values || []).map(String);
      if (destination && !values.includes(destination)) {
        deny("allowlist", `destination ${destination} not in allowlist`);
      }
    } else if (rule.type === "require_approval") {
      if (rule.when_amount_over != null && amount > rule.when_amount_over) {
        review(
          "require_approval",
          `amount ${amount} above approval threshold ${rule.when_amount_over}`
        );
      }
    } else if (rule.type === "time_window" && Array.isArray(rule.allow_utc_hours)) {
      const hour = new Date().getUTCHours();
      const inside = rule.allow_utc_hours.some(([a, b]) => hour >= a && hour < b);
      if (!inside) deny("time_window", `UTC hour ${hour} outside allowed windows`);
    }
  }

  if (verdict === "allow") {
    dailySpend.set(agentId, { day, spent: spentToday + amount });
    persistence.saveSpend(agentId, day, spentToday + amount);
    reasons.push("all rules satisfied");
  }
  return {
    verdict,
    triggered_rules: triggered,
    reasons,
    policy_used: policy.name || "inline",
    agent_id: agentId,
    spent_today_after: verdict === "allow" ? spentToday + amount : spentToday,
    evaluated_at: new Date().toISOString(),
  };
}

function issueVerdict(agentId, amount, day) {
  const id = crypto.randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  const verdict = {
    id,
    agent_id: String(agentId),
    amount: Number(amount || 0),
    day,
    status: "pending",
    issued_at: issuedAt,
    expires_at_ms: Date.now() + VERDICT_TTL_S * 1000,
    consumed_at: null,
  };
  verdicts.set(id, verdict);
  persistence.saveVerdict(verdict);
  persistence.audit("verdict_issued", verdict.agent_id, id, {
    amount: verdict.amount,
    day: verdict.day,
    expires_in_seconds: VERDICT_TTL_S,
  });
  armVerdictExpiry(verdict);
  return { verdict_id: id, expires_in_seconds: VERDICT_TTL_S };
}

function armVerdictExpiry(verdict) {
  const remainingMs = verdict.expires_at_ms - Date.now();
  if (remainingMs <= 0) return;
  setTimeout(() => expireVerdict(verdict), remainingMs + 10).unref();
}

function expireVerdict(verdict) {
  if (!verdict || verdict.status !== "pending" || Date.now() < verdict.expires_at_ms) return false;
  verdict.status = "expired";
  const today = new Date().toISOString().slice(0, 10);
  let refunded = false;
  if (verdict.day === today) {
    const current = dailySpend.get(verdict.agent_id);
    if (current && current.day === verdict.day) {
      current.spent = Math.max(0, current.spent - verdict.amount);
      dailySpend.set(verdict.agent_id, current);
      persistence.saveSpend(verdict.agent_id, current.day, current.spent);
      refunded = true;
    }
  }
  persistence.updateVerdict(verdict);
  persistence.audit("verdict_expired", verdict.agent_id, verdict.id, {
    amount: verdict.amount,
    day: verdict.day,
    refunded,
  });
  return true;
}

function chargeApprovedVerdict(approval) {
  const agentId = approval.request.agent_id;
  const amount = approval.request.amount;
  const day = new Date().toISOString().slice(0, 10);
  const current = dailySpend.get(agentId);
  const spent = current && current.day === day ? current.spent : 0;
  dailySpend.set(agentId, { day, spent: spent + amount });
  persistence.saveSpend(agentId, day, spent + amount);
  return issueVerdict(agentId, amount, day);
}

// ---------------------------------------------------------------------------
// Human-in-the-loop approvals (review verdicts -> Telegram, when configured)
// ---------------------------------------------------------------------------

// approval_id -> { status: pending|approved|denied|expired, request, verdict,
//                  created_at, resolved_at, waiters: [resolve...] }
const approvals = new Map();

function newApprovalId() {
  return crypto.randomBytes(8).toString("hex");
}

async function tg(method, payload) {
  if (!TG_TOKEN) return null;
  // The route to api.telegram.org from this host is slow and lossy. Two
  // attempts with a generous timeout; all callers are fire-and-forget or
  // tolerate null, so worst case we lose a notification, never a request.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      return await r.json();
    } catch (err) {
      console.error(`telegram ${method} attempt ${attempt}/2 failed:`, err.message);
    }
  }
  return null;
}

function resolveApproval(id, status) {
  const a = approvals.get(id);
  if (!a || a.status !== "pending") return null;
  a.status = status;
  a.resolved_at = new Date().toISOString();
  a.final_verdict = status === "approved" ? "allow" : "deny";
  if (status === "approved" && a.bind_requested === true) {
    a.execution_binding = chargeApprovedVerdict(a);
  }
  persistence.updateApproval(a);
  persistence.audit("approval_resolved", a.request.agent_id, id, {
    status,
    final_verdict: a.final_verdict,
  });
  for (const wake of a.waiters) wake(a);
  a.waiters = [];
  return a;
}

function armApprovalExpiry(id, delayMs) {
  setTimeout(() => {
    const done = resolveApproval(id, "expired");
    if (done && done.tg_message_id) {
      tg("editMessageText", {
        chat_id: done.tg_chat_id,
        message_id: done.tg_message_id,
        text: `🦞 Claw request ${id}\n⏰ Expired — no decision within ${APPROVAL_TIMEOUT_S}s. Denied by default.`,
      });
    }
  }, Math.max(delayMs, 0)).unref();
}

async function requestApproval(body, verdict) {
  const id = newApprovalId();
  const a = {
    id,
    status: "pending",
    request: {
      agent_id: String(body.agent_id || "anonymous"),
      action: String(body.action || "spend"),
      amount: Number(body.amount || 0),
      destination: body.destination ? String(body.destination) : null,
    },
    verdict,
    created_at: new Date().toISOString(),
    waiters: [],
    tg_message_id: null,
    tg_chat_id: chatForAgent(body.agent_id),
    bind_requested: body.bind === true,
  };
  approvals.set(id, a);
  persistence.saveApproval(a);
  persistence.audit("approval_created", a.request.agent_id, id, {
    amount: a.request.amount,
    destination: a.request.destination,
  });
  armApprovalExpiry(id, APPROVAL_TIMEOUT_S * 1000);

  const lines = [
    "🦞 Claw needs your attention!",
    ``,
    `Agent \`${a.request.agent_id}\` wants: ${a.request.action} ${a.request.amount} USDT` +
      (a.request.destination ? ` → ${a.request.destination}` : ""),
    `Reason: ${verdict.reasons.join("; ")}`,
    ``,
    `id: ${id}`,
  ];
  // Fire-and-forget: the caller gets its approval_id immediately; a slow
  // Telegram delays only the notification, never the HTTP response.
  const sentPromise = tg("sendMessage", {
    chat_id: a.tg_chat_id,
    text: lines.join("\n"),
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `approve:${id}` },
        { text: "❌ Deny", callback_data: `deny:${id}` },
      ]],
    },
  });
  sentPromise.then((sent) => {
    if (sent && sent.ok) a.tg_message_id = sent.result.message_id;
  });
  return a;
}

function approvalView(a) {
  return {
    approval_id: a.id,
    status: a.status,
    final_verdict: a.status === "approved" ? "allow" : a.status === "pending" ? null : "deny",
    request: a.request,
    created_at: a.created_at,
    resolved_at: a.resolved_at || null,
    ...(a.execution_binding || {}),
  };
}

// ---------------------------------------------------------------------------
// x402 pay-per-call middleware (only mounted on /paid/* mirror routes)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// x402 payment layer (v0.6) — official OKX Payment SDK (@okxweb3/x402-*)
// ---------------------------------------------------------------------------
// The hand-rolled 402 challenge / verify / settle from v0.2–v0.5 is gone.
// The SDK produces the A2MCP-standard 402 (base64 PAYMENT-REQUIRED header
// carrying {x402Version:2, resource, accepts:[...]}) and brokers verify +
// settle through the OKX facilitator. Same env vars as before:
//   OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE / X402_PAY_TO

let x402Ready = false;      // true once resourceServer.initialize() succeeds
let initX402 = null;        // invoked from app.listen()
let paymentMiddleware;      // gates /paid/* (SDK when on, 503 when off)
const verifiedPaymentPayers = new Map();

function paymentKey(payload) {
  return crypto.createHash("sha256").update(canonical(payload)).digest("hex");
}

function payerForRequest(req) {
  try {
    const encoded = req.get("payment-signature") || req.get("x-payment") || "";
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const found = verifiedPaymentPayers.get(paymentKey(payload));
    return found && found.payer;
  } catch {
    return null;
  }
}

function lifecycleRequest(context) {
  const transport = context && context.transportContext;
  const requestContext = transport && (transport.request || transport);
  return requestContext && requestContext.adapter && requestContext.adapter.req;
}

function isClaimPath(req) {
  return req && (req.path === "/paid/v1/agents/claim" || req.path === "/paid-okx/v1/agents/claim");
}

function installClaimPaymentHooks(resourceServer) {
  resourceServer.onAfterVerify(async (context) => {
    const key = paymentKey(context.paymentPayload);
    verifiedPaymentPayers.set(key, {
      payer: context.result && context.result.payer,
      created_at: Date.now(),
    });
    if (verifiedPaymentPayers.size > 10000) {
      verifiedPaymentPayers.delete(verifiedPaymentPayers.keys().next().value);
    }
  });
  resourceServer.onAfterSettle(async (context) => {
    verifiedPaymentPayers.delete(paymentKey(context.paymentPayload));
    const req = lifecycleRequest(context);
    if (!req || !req._claimTransaction) return;
    const transaction = req._claimTransaction;
    const payer = String((context.result && context.result.payer) || "");
    if (!payer) throw new Error("settlement did not identify a payer wallet");
    await persistence.commitClaim(transaction, payer);
    if (!transaction.committed) return;
    claimedAgents.set(transaction.agentId, {
      agent_id: transaction.agentId,
      secret_hash: transaction.secretHash,
      claimed_at: transaction.claimedAt,
      claimed_by: payer,
      strict_mode: false,
    });
    persistence.audit("agent_claimed", transaction.agentId, transaction.agentId, {
      claimed_by: payer,
    });
    if (!payersEqual(transaction.verifiedPayer, payer)) {
      healthCounters.claim_payer_mismatch++;
      persistence.audit("claim_payer_mismatch", transaction.agentId, transaction.agentId, {
        verified_payer: transaction.verifiedPayer || null,
        settlement_payer: payer,
      });
    }
    req._claimTransaction = null;
  });
  const rollback = async (context) => {
    if (context && context.paymentPayload) {
      verifiedPaymentPayers.delete(paymentKey(context.paymentPayload));
    }
    const req = lifecycleRequest(context);
    if (!req || !req._claimTransaction) return;
    await persistence.rollbackClaim(req._claimTransaction);
    req._claimTransaction = null;
  };
  resourceServer.onSettleFailure(rollback);
  if (typeof resourceServer.onVerifiedPaymentCanceled === "function") {
    resourceServer.onVerifiedPaymentCanceled(rollback);
  }
}

if (PAYMENT_MODE === "okx-x402") {
  const { OKXFacilitatorClient } = require("@okxweb3/x402-core");
  const {
    x402ResourceServer,
    x402HTTPResourceServer,
    paymentMiddlewareFromHTTPServer,
  } = require("@okxweb3/x402-express");
  const { ExactEvmScheme } = require("@okxweb3/x402-evm/exact/server");

  const facilitatorClient = new OKXFacilitatorClient({
    apiKey: OKX.apiKey,
    secretKey: OKX.secretKey,
    passphrase: OKX.passphrase,
    baseUrl: X402.facilitator,
    syncSettle: true, // wait for on-chain confirmation before delivering
  });

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    X402.network,
    new ExactEvmScheme()
  );
  installClaimPaymentHooks(resourceServer);

  const accepts = {
    scheme: "exact",
    network: X402.network,          // eip155:196 (X Layer)
    payTo: X402.payTo,
    price: X402.price,              // "$0.01" -> USDT0 atomic units (SDK converts)
    maxTimeoutSeconds: X402.maxTimeoutSeconds,
  };
  // GET mirrors exist so any probe (curl -i, review bots, buyer discovery)
  // sees a standard 402 challenge instead of a 404.
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "POST /paid/v1/guard/check": {
      accepts,
      description: "Claw-in-a-Box spend-policy verdict (pay per call)",
      mimeType: "application/json",
    },
    "GET /paid/v1/guard/check": {
      accepts,
      description: "Claw-in-a-Box spend-policy verdict (POST JSON to this path)",
      mimeType: "application/json",
    },
    "POST /paid/v1/tokens/verify": {
      accepts,
      description: "Claw-in-a-Box capability-token verification (pay per call)",
      mimeType: "application/json",
    },
    "GET /paid/v1/tokens/verify": {
      accepts,
      description: "Claw-in-a-Box capability-token verification (POST JSON to this path)",
      mimeType: "application/json",
    },
    "POST /paid/v1/agents/claim": {
      accepts,
      description: "Pay-to-Claim an agent_id and receive its one-time agent secret",
      mimeType: "application/json",
    },
    "GET /paid/v1/agents/claim": {
      accepts,
      description: "Pay-to-Claim an agent_id (POST JSON to this path)",
      mimeType: "application/json",
    },
    // v0.7.1: host-independent OKX-rail mirrors. The api host routes /paid/*
    // to the CDP layer, so the OKX listing endpoint moves to /paid-okx/* -
    // same handlers, same accepts (X Layer / USDT0), reachable on any host.
    "POST /paid-okx/v1/guard/check": {
      accepts,
      description: "Claw-in-a-Box spend-policy verdict (pay per call)",
      mimeType: "application/json",
    },
    "GET /paid-okx/v1/guard/check": {
      accepts,
      description: "Claw-in-a-Box spend-policy verdict (POST JSON to this path)",
      mimeType: "application/json",
    },
    "POST /paid-okx/v1/tokens/verify": {
      accepts,
      description: "Claw-in-a-Box capability-token verification (pay per call)",
      mimeType: "application/json",
    },
    "GET /paid-okx/v1/tokens/verify": {
      accepts,
      description: "Claw-in-a-Box capability-token verification (POST JSON to this path)",
      mimeType: "application/json",
    },
    "POST /paid-okx/v1/agents/claim": {
      accepts,
      description: "Pay-to-Claim an agent_id and receive its one-time agent secret",
      mimeType: "application/json",
    },
    "GET /paid-okx/v1/agents/claim": {
      accepts,
      description: "Pay-to-Claim an agent_id (POST JSON to this path)",
      mimeType: "application/json",
    },
  });

  // syncFacilitatorOnStart=false: the factory's own eager sync is an
  // unhandled rejection if the facilitator is briefly unreachable at boot.
  // We drive initialization ourselves below, with retry.
  paymentMiddleware = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);

  // MUST run after the HTTP server starts; retried until the facilitator
  // answers so a transient outage at boot cannot brick the paid routes.
  initX402 = function retryInit() {
    httpServer
      .initialize()
      .then(() => {
        x402Ready = true;
        console.log("[x402] SDK initialized — facilitator synced");
      })
      .catch((err) => {
        console.error("[x402] initialize failed, retrying in 60s:", err.message);
        setTimeout(retryInit, 60000).unref();
      });
  };
} else {
  paymentMiddleware = (_req, res) => {
    res.status(503).json({
      error: "payments_disabled",
      detail: "PAYMENT_MODE is off; use the free routes under /v1/",
    });
  };
}

// ---------------------------------------------------------------------------
// x402 payment layer #2 (v0.7) - Coinbase CDP facilitator, api host only
// ---------------------------------------------------------------------------
// Mirror of the OKX block above, pointed at the CDP facilitator so the same
// paid routes are also payable in USDC on Base (eip155:8453). The routes
// declare Bazaar discovery metadata: after the FIRST successful settlement
// through CDP, the endpoint is indexed by the x402 Bazaar automatically -
// there is no separate listing or review step.
//   env: CDP_API_KEY_ID / CDP_API_KEY_SECRET (portal.cdp.coinbase.com)
//        CDP_PAY_TO (defaults to X402_PAY_TO - same EVM address works on Base)
//        DISCOVERY=off disables Bazaar declarations for permanent staging
const DISCOVERY_ENABLED = String(process.env.DISCOVERY || "on").toLowerCase() !== "off";
const CDP = {
  keyId: process.env.CDP_API_KEY_ID || "",
  keySecret: process.env.CDP_API_KEY_SECRET || "",
  payTo: process.env.CDP_PAY_TO || process.env.X402_PAY_TO || "",
  network: process.env.CDP_X402_NETWORK || "eip155:8453", // Base mainnet
  price: process.env.CDP_X402_PRICE || "$0.01",
  // Override for tests / outages; default is Coinbase's hosted facilitator.
  facilitatorUrl: process.env.CDP_FACILITATOR_URL || "",
  maxTimeoutSeconds: Number(process.env.X402_MAX_TIMEOUT_S || 600),
};
// Enabled when we can settle: either CDP keys (official facilitator, gets
// indexed by the Bazaar) or an explicit keyless facilitator URL (community
// facilitators on Base - payments work, but no CDP Bazaar indexing).
const CDP_ENABLED = Boolean(CDP.payTo && ((CDP.keyId && CDP.keySecret) || CDP.facilitatorUrl));
let cdpReady = false;   // true once the CDP resource server has synced
let initCdp = null;     // invoked from app.listen()
let cdpPaymentMiddleware = (_req, res) => {
  res.status(503).json({
    error: "payments_disabled",
    detail: "CDP x402 is not configured on this host; use the free routes under /v1/",
  });
};

if (CDP_ENABLED) {
  const {
    x402ResourceServer: CdpResourceServerCtor,
    x402HTTPResourceServer: CdpHTTPResourceServerCtor,
    paymentMiddlewareFromHTTPServer: cdpMiddlewareFromHTTPServer,
  } = require("@x402/express");
  const { HTTPFacilitatorClient } = require("@x402/core/server");
  const { ExactEvmScheme: CdpExactEvmScheme } = require("@x402/evm/exact/server");
  const { createFacilitatorConfig } = require("@coinbase/x402");

  // createFacilitatorConfig defaults to https://api.cdp.coinbase.com/platform/v2/x402
  // and signs verify/settle with the CDP keys. Tests point it at a local mock.
  const facConfig =
    CDP.keyId && CDP.keySecret
      ? createFacilitatorConfig(CDP.keyId, CDP.keySecret)
      : {}; // keyless: plain HTTP facilitator, no auth headers
  if (CDP.facilitatorUrl) facConfig.url = CDP.facilitatorUrl;
  const cdpFacilitatorClient = new HTTPFacilitatorClient(facConfig);

  const cdpResourceServer = new CdpResourceServerCtor(cdpFacilitatorClient)
    .register(CDP.network, new CdpExactEvmScheme());
  installClaimPaymentHooks(cdpResourceServer);

  const cdpAccepts = {
    scheme: "exact",
    network: CDP.network,
    payTo: CDP.payTo,
    price: CDP.price, // "$0.01" -> USDC atomic units (SDK converts)
    maxTimeoutSeconds: CDP.maxTimeoutSeconds,
  };

  let guardDiscovery;
  let verifyDiscovery;
  if (DISCOVERY_ENABLED) {
    const {
      bazaarResourceServerExtension,
      declareDiscoveryExtension,
    } = require("@x402/extensions/bazaar");
    cdpResourceServer.registerExtension(bazaarResourceServerExtension);

    // Bazaar semantic search ranks on description + schema quality; these are
    // the listing copy, not just docs. POST routes carry full discovery
    // metadata; GET mirrors exist for probes and are not declared discoverable.
    guardDiscovery = declareDiscoveryExtension({
      method: "POST",
      input: { agent_id: "agent-7", amount: 150, destination: "merchant-x", policy: "standard" },
      inputSchema: {
        properties: {
          agent_id: { type: "string", description: "stable id of the spending agent (per-agent daily ledger)" },
          amount: { type: "number", description: "proposed spend amount" },
          destination: { type: "string", description: "optional payee / merchant identifier checked against allowlists" },
          policy: { description: "preset name (conservative|standard|permissive) or inline policy object", type: "string" },
          wait: { type: "boolean", description: "if the verdict is 'review', block until a human approves/denies on Telegram (default 120s timeout)" },
        },
        required: ["agent_id", "amount"],
      },
      bodyType: "json",
      output: {
        example: {
          verdict: "review",
          triggered: ["review_threshold"],
          reasons: ["amount 150 exceeds review threshold 100"],
          approval_id: "apr_9f2c1a",
          poll: "/v1/approvals/apr_9f2c1a",
        },
      },
    });
    verifyDiscovery = declareDiscoveryExtension({
      method: "POST",
      input: { token: "<base64url capability token>", presenter: "worker-agent" },
      inputSchema: {
        properties: {
          token: { type: "string", description: "capability token (macaroon-style HMAC chain, base64url)" },
          presenter: { type: "string", description: "optional audience check: who is presenting this token" },
        },
        required: ["token"],
      },
      bodyType: "json",
      output: {
        example: { valid: true, context: { subject: "root-agent", scopes: ["payments:read"], depth: 1 } },
      },
    });
  }

  const guardDesc =
    "Spend-policy verdict for AI agents: POST a proposed spend, get allow/review/deny " +
    "with the exact rules that fired (per-tx caps, per-agent daily ledger, destination " +
    "allowlists, time windows) - 'review' can page a human on Telegram for approval " +
    "before the agent proceeds. Pay per call.";
  const verifyDesc =
    "Verify a delegatable capability token (macaroon-style HMAC chain): checks " +
    "attenuation, expiry, audience binding and cascading revocation, returns the " +
    "resolved scope context. Pay per call.";

  const cdpHttpServer = new CdpHTTPResourceServerCtor(cdpResourceServer, {
    "POST /paid/v1/guard/check": {
      accepts: cdpAccepts,
      description: guardDesc,
      mimeType: "application/json",
      serviceName: "Claw-in-a-Box",
      iconUrl: process.env.SERVICE_ICON_URL || "https://clawinabox.xyz/logo-256-white.png",
      tags: ["infra", "ai-agents", "spend-guard", "policy", "human-in-the-loop", "authorization"],
      ...(guardDiscovery ? { extensions: guardDiscovery } : {}),
    },
    "GET /paid/v1/guard/check": {
      accepts: cdpAccepts,
      description: "Claw-in-a-Box spend-policy verdict (POST JSON to this path)",
      mimeType: "application/json",
    },
    "POST /paid/v1/tokens/verify": {
      accepts: cdpAccepts,
      description: verifyDesc,
      mimeType: "application/json",
      serviceName: "Claw-in-a-Box",
      iconUrl: process.env.SERVICE_ICON_URL || "https://clawinabox.xyz/logo-256-white.png",
      tags: ["infra", "ai-agents", "capability-tokens", "delegation", "revocation", "authorization"],
      ...(verifyDiscovery ? { extensions: verifyDiscovery } : {}),
    },
    "GET /paid/v1/tokens/verify": {
      accepts: cdpAccepts,
      description: "Claw-in-a-Box capability-token verification (POST JSON to this path)",
      mimeType: "application/json",
    },
    "POST /paid/v1/agents/claim": {
      accepts: cdpAccepts,
      description: "Pay-to-Claim an agent_id: settlement anchors the payer wallet and returns a one-time agent secret",
      mimeType: "application/json",
      serviceName: "Claw-in-a-Box",
      iconUrl: process.env.SERVICE_ICON_URL || "https://clawinabox.xyz/logo-256-white.png",
      tags: ["infra", "ai-agents", "identity", "pay-to-claim", "authorization"],
    },
    "GET /paid/v1/agents/claim": {
      accepts: cdpAccepts,
      description: "Pay-to-Claim an agent_id (POST JSON to this path)",
      mimeType: "application/json",
    },
  });

  // Same defensive boot as the OKX layer: no eager sync (an unreachable
  // facilitator at boot must not brick the process), init retried from
  // app.listen() until it succeeds.
  cdpPaymentMiddleware = cdpMiddlewareFromHTTPServer(cdpHttpServer, undefined, undefined, false);
  initCdp = function retryCdpInit() {
    cdpHttpServer
      .initialize()
      .then(() => {
        cdpReady = true;
        console.log("[x402-cdp] SDK initialized - CDP facilitator synced");
      })
      .catch((err) => {
        console.error("[x402-cdp] initialize failed, retrying in 60s:", err.message);
        setTimeout(retryCdpInit, 60000).unref();
      });
  };
}

// Settlement bookkeeping is SDK-managed now; this set only feeds /healthz
// metrics and the periodic sweep (kept to avoid touching v0.5 plumbing).
const settled = new Set();

// ---------------------------------------------------------------------------
// Memory discipline (v0.5)
// ---------------------------------------------------------------------------
// Every collection in this process used to grow forever, and the free routes
// had no rate limit — so anyone could exhaust memory by calling
// /v1/guard/check with a fresh agent_id in a loop. That is what took the box
// down on July 13. Caps, TTLs, and a periodic sweep below.
//
// Note the two v0.4 additions are swept too: expired bind codes, and (capped)
// operator bindings — a binding is a real user's setting, so it is trimmed
// last and only under extreme pressure.

const MAX_REVOKED = Number(process.env.MAX_REVOKED || 20000);
const MAX_SETTLED = Number(process.env.MAX_SETTLED || 10000);
const MAX_SPEND_ROWS = Number(process.env.MAX_SPEND_ROWS || 20000);
const MAX_BINDINGS = Number(process.env.MAX_BINDINGS || 5000);
const APPROVAL_KEEP_MS = Number(process.env.APPROVAL_KEEP_MS || 30 * 60 * 1000);

function trimSet(set, max) {
  if (set.size <= max) return 0;
  let drop = set.size - max;
  const n = drop;
  for (const v of set) {
    set.delete(v);
    if (--drop <= 0) break;
  }
  return n;
}

function sweep() {
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  let freed = 0;

  for (const [key, verified] of verifiedPaymentPayers) {
    if (now - verified.created_at > 10 * 60 * 1000) {
      verifiedPaymentPayers.delete(key);
      freed++;
    }
  }

  // Resolved approvals are dead weight once the caller has read them.
  for (const [id, a] of approvals) {
    const done = a.status !== "pending";
    const age = now - new Date(a.created_at).getTime();
    if ((done && age > APPROVAL_KEEP_MS) || age > 2 * APPROVAL_KEEP_MS) {
      approvals.delete(id);
      persistence.deleteApproval(id);
      freed++;
    }
  }
  persistence.purgeOldSpend(today);

  for (const [id, verdict] of verdicts) {
    expireVerdict(verdict);
    if (verdict.status !== "pending" && now - new Date(verdict.issued_at).getTime() > APPROVAL_KEEP_MS) {
      verdicts.delete(id);
      freed++;
    }
  }

  // Bind codes are one-shot and short-lived; drop the expired ones.
  for (const [code, p] of pendingBinds) {
    if (now - p.created > BIND_TTL_MS) {
      pendingBinds.delete(code);
      freed++;
    }
  }

  // Spend rows only matter for today.
  for (const [agent, row] of dailySpend) {
    if (row.day !== today) {
      dailySpend.delete(agent);
      freed++;
    }
  }
  if (dailySpend.size > MAX_SPEND_ROWS) {
    let drop = dailySpend.size - MAX_SPEND_ROWS;
    for (const k of dailySpend.keys()) {
      dailySpend.delete(k);
      freed++;
      if (--drop <= 0) break;
    }
  }

  // A binding is a user's deliberate setting — only trim under real pressure.
  if (operatorBindings.size > MAX_BINDINGS) {
    let drop = operatorBindings.size - MAX_BINDINGS;
    for (const k of operatorBindings.keys()) {
      operatorBindings.delete(k);
      freed++;
      if (--drop <= 0) break;
    }
    console.warn("[sweep] operator bindings hit cap — callers will need to /bind again");
  }

  freed += trimSet(revoked, MAX_REVOKED);
  freed += trimSet(settled, MAX_SETTLED);

  if (freed > 0) {
    const mb = (process.memoryUsage().heapUsed / 1048576).toFixed(1);
    console.log(
      `[sweep] freed ${freed}; heap ${mb} MB; revoked=${revoked.size} spend=${dailySpend.size} ` +
        `approvals=${approvals.size} settled=${settled.size} bindings=${operatorBindings.size}`
    );
  }
}
setInterval(sweep, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
// The difference between "a stranger can OOM this box" and "a stranger cannot".
// Paid routes are exempt: payment is its own admission control.
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60000);
const RATE_MAX = Number(process.env.RATE_MAX || 60);
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = String(req.get("x-forwarded-for") || req.ip || "?").split(",")[0].trim();
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.resetAt) {
    h = { count: 0, resetAt: now + RATE_WINDOW_MS };
    hits.set(ip, h);
  }
  h.count++;
  if (h.count > RATE_MAX) {
    res.set("Retry-After", String(Math.ceil((h.resetAt - now) / 1000)));
    return res.status(429).json({
      error: "rate_limited",
      detail: `over ${RATE_MAX} requests per ${RATE_WINDOW_MS / 1000}s from this address`,
    });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (now > h.resetAt) hits.delete(ip);
}, RATE_WINDOW_MS).unref();
// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

function guardError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = code === "invalid_token" || code === "invalid_signature" ? 400 : 403;
  return err;
}

const need = (body, field) => {
  const v = body[field];
  if (v === undefined || v === null || v === "") {
    throw guardError("missing_field", `field '${field}' is required`);
  }
  return v;
};

const app = express();
// Behind Hostinger's reverse proxy TLS terminates upstream; trust X-Forwarded-*
// so req.protocol resolves to "https" (the SDK builds resource.url from it).
app.set("trust proxy", 1);
app.use((req, _res, next) => {
  if (!req.headers["x-forwarded-proto"]) req.headers["x-forwarded-proto"] = "https";
  next();
});
app.use(express.json({ limit: "64kb", type: () => true }));
app.use((req, res, next) => {
  res.set({
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-agent-secret, payment-signature, x-payment",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Payment gating for /paid/* (must be mounted before the route handlers).
// SDK middleware only intercepts its declared "METHOD /path" routes.
//
// v0.7 host dispatch: the OKX listing's on-chain endpoint lives on the okx
// host and must keep v0.6 behavior exactly, so any host that is not API_HOST
// takes the v0.6 code path unchanged. Requests to API_HOST route /paid/*
// through the CDP layer (Base/USDC, Bazaar-indexed). Free routes are never
// gated on any host.
const API_HOST = String(process.env.API_HOST || "api.clawinabox.xyz").toLowerCase();
app.use((req, res, next) => {
  if (isClaimPath(req)) {
    if (!persistence.hardReady()) {
      return res.status(503).json({
        error: "feature_disabled",
        detail: "Pay-to-Claim requires PERSISTENCE=on and a connected, hydrated database",
      });
    }
    const agentId = String((req.body || {}).agent_id || "").trim();
    if (agentId && claimedAgents.has(agentId)) {
      return res.status(409).json({ error: "already_claimed", detail: "agent_id is already claimed" });
    }
  }
  if (String(req.hostname || "").toLowerCase() === API_HOST && CDP_ENABLED) {
    // ORDER MATTERS: "/paid-okx" also startsWith "/paid" - check it first,
    // otherwise the CDP middleware would pass it through UNPAID (it only
    // intercepts its own declared routes).
    if (req.path.startsWith("/paid-okx")) return paymentMiddleware(req, res, next);
    if (!req.path.startsWith("/paid")) return next();
    return cdpPaymentMiddleware(req, res, next);
  }
  // v0.6 path, byte-for-byte:
  if (PAYMENT_MODE === "okx-x402") return paymentMiddleware(req, res, next);
  if (req.path.startsWith("/paid")) return paymentMiddleware(req, res, next);
  return next();
});

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    service: "claw-in-a-box",
    version: "0.8.1",
    features: {
      telegram_hitl: TG_ENABLED,
      payment_mode: PAYMENT_MODE,
      x402_sdk_ready: x402Ready,
      x402_pay_to_set: Boolean(X402.payTo),
      okx_credentials_set: OKX_READY,
      okx_passphrase_set: Boolean(OKX.passphrase),
      facilitator: X402.facilitator,
      multi_tenant_approvals: true,
      cdp_x402_enabled: CDP_ENABLED,
      cdp_keys_set: Boolean(CDP.keyId && CDP.keySecret),
      cdp_x402_ready: cdpReady,
      cdp_discovery_enabled: DISCOVERY_ENABLED,
      cdp_network: CDP.network,
      api_host: API_HOST,
      persistence: persistence.state,
    },
    memory: {
      heap_mb: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
      revoked: revoked.size,
      spend_rows: dailySpend.size,
      approvals: approvals.size,
      settled: settled.size,
      bindings: operatorBindings.size,
      claimed_agents: claimedAgents.size,
      verdicts: verdicts.size,
      uptime_s: Math.round(process.uptime()),
    },
    counters: healthCounters,
  });
});

// Human-facing landing page. Buyers, reviewers and curious clickers land here;
// machines go to /skill.md and /healthz.
app.get("/", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(LANDING_HTML);
});

const SKILL_MD = fs.readFileSync(path.join(__dirname, "SKILL.md"), "utf8");
app.get("/skill.md", (req, res) => {
  // Same document on both hosts; only the advertised base URL differs.
  const base =
    String(req.hostname || "").toLowerCase() === API_HOST
      ? "https://api.clawinabox.xyz"
      : "https://okx.clawinabox.xyz";
  res.type("text/markdown; charset=utf-8");
  res.send(SKILL_MD.replaceAll("{{BASE_URL}}", base));
});

// Unified status page (ported from api v0.1.3): /status is the human page,
// /status/probe does the actual outbound probing - manual trigger only.
mountStatus(app, rateLimit);

app.post("/v1/tokens", rateLimit, (req, res) => {
  const b = req.body || {};
  res.json({
    token: issueRoot(String(need(b, "subject")), need(b, "scopes"), Number(b.ttl_seconds)),
  });
});

app.post("/v1/tokens/delegate", rateLimit, (req, res) => {
  const b = req.body || {};
  res.json({
    token: delegateToken(
      need(b, "parent_token"),
      String(need(b, "audience")),
      need(b, "scopes"),
      Number(b.ttl_seconds)
    ),
  });
});

app.post("/v1/tokens/verify", rateLimit, (req, res) => {
  const b = req.body || {};
  res.json({
    valid: true,
    context: verifyToken(need(b, "token"), b.presenter ? String(b.presenter) : null),
  });
});

app.post("/v1/tokens/revoke", rateLimit, (req, res) => {
  res.json(revokeToken(need(req.body || {}, "token")));
});

async function guardCheckHandler(req, res, next) {
  try {
    const input = req.body || {};
    const requestedAgentId = String(input.agent_id || "anonymous");
    const claimed = requireAgentSecret(req, requestedAgentId, { strictOnly: true });
    const b = claimed && claimed.agent_id !== requestedAgentId
      ? { ...input, agent_id: claimed.agent_id }
      : input;
    const agentId = String(b.agent_id || "anonymous");
    const verdict = guardCheck(b);
    if (verdict.verdict !== "review" || !TG_ENABLED) {
      if (b.bind === true && verdict.verdict === "allow") {
        const binding = issueVerdict(agentId, Number(b.amount || 0), new Date().toISOString().slice(0, 10));
        return res.json({ ...verdict, ...binding });
      }
      return res.json(verdict);
    }
    // review + Telegram configured: open a human-in-the-loop approval
    const a = await requestApproval(b, verdict);
    const enriched = {
      ...verdict,
      approval_id: a.id,
      approval_status: a.status,
      poll: `/v1/approvals/${a.id}`,
      note: `A human has been notified on Telegram. Poll the approval, or retry with "wait": true to block up to ${APPROVAL_TIMEOUT_S}s.`,
    };
    if (b.wait !== true) return res.json(enriched);
    // long-poll: hold the request until resolved or timeout
    const resolved = await new Promise((resolve) => {
      a.waiters.push(resolve);
    });
    return res.json({
      ...verdict,
      verdict: resolved.final_verdict,
      approval_id: a.id,
      approval_status: resolved.status,
      reasons: [...verdict.reasons,
        resolved.status === "approved" ? "approved by human via Telegram"
        : resolved.status === "denied" ? "denied by human via Telegram"
        : `no human decision within ${APPROVAL_TIMEOUT_S}s — denied by default`],
      ...(resolved.execution_binding || {}),
    });
  } catch (error) {
    return next(error);
  }
}

app.post("/v1/guard/check", rateLimit, guardCheckHandler);

app.get("/v1/approvals/:id", (req, res) => {
  const a = approvals.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not_found", detail: "unknown approval id" });
  res.json(approvalView(a));
});

app.post("/v1/verdicts/:id/consume", rateLimit, (req, res) => {
  const verdict = verdicts.get(String(req.params.id));
  if (!verdict) {
    return res.status(404).json({ error: "not_found", detail: "unknown or expired verdict id" });
  }
  if (expireVerdict(verdict) || verdict.status === "expired") {
    return res.status(404).json({ error: "not_found", detail: "unknown or expired verdict id" });
  }
  if (verdict.status === "consumed") {
    return res.status(409).json({
      error: "already_consumed",
      consumed_at: verdict.consumed_at,
    });
  }
  verdict.status = "consumed";
  verdict.consumed_at = new Date().toISOString();
  persistence.updateVerdict(verdict);
  persistence.audit("verdict_consumed", verdict.agent_id, verdict.id, {
    consumed_at: verdict.consumed_at,
  });
  return res.json({ verdict_id: verdict.id, status: "consumed", consumed_at: verdict.consumed_at });
});

// Telegram webhook: receives Approve/Deny button presses
app.post("/telegram/webhook", (req, res) => {
  if (TG_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== TG_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  res.json({ ok: true }); // ack fast; Telegram retries otherwise

  // (a) /bind CODE — a caller links their own chat to their agent_id
  const msg = (req.body || {}).message;
  if (msg && typeof msg.text === "string" && msg.text.trim().startsWith("/bind")) {
    const code = msg.text.trim().split(/\s+/)[1] || "";
    const pend = pendingBinds.get(code.toUpperCase());
    if (pend && Date.now() - pend.created < BIND_TTL_MS) {
      operatorBindings.set(pend.agent_id, String(msg.chat.id));
      persistence.saveBinding(pend.agent_id, String(msg.chat.id));
      persistence.audit("binding_changed", pend.agent_id, pend.agent_id, {
        routing: "caller",
      });
      pendingBinds.delete(code.toUpperCase());
      tg("sendMessage", {
        chat_id: msg.chat.id,
        text: `✅ Bound. Review requests for agent \`${pend.agent_id}\` will now come to this chat.`,
        parse_mode: "Markdown",
      });
    } else {
      tg("sendMessage", {
        chat_id: msg.chat.id,
        text: "⚠️ Invalid or expired bind code. Request a fresh one via POST /v1/operators/register.",
      });
    }
    return;
  }

  // (b) Approve/Deny button presses
  const cq = (req.body || {}).callback_query;
  if (!cq || !cq.data) return;
  const [action, id] = String(cq.data).split(":");
  const status = action === "approve" ? "approved" : "denied";
  const a = resolveApproval(id, status);
  tg("answerCallbackQuery", { callback_query_id: cq.id, text: a ? `Recorded: ${status}` : "Already resolved" });
  if (a && a.tg_message_id) {
    const icon = status === "approved" ? "✅ Approved" : "❌ Denied";
    tg("editMessageText", {
      chat_id: a.tg_chat_id,
      message_id: a.tg_message_id,
      text: `🦞 Claw request ${id}\n${icon} — agent \`${a.request.agent_id}\`, ${a.request.action} ${a.request.amount} USDT.`,
      parse_mode: "Markdown",
    });
  }
});

// x402 paid mirrors (register THESE endpoints on OKX.AI; free routes stay
// free). Payment is enforced by the SDK middleware mounted above — these
// handlers only run for requests that have already paid.
const paidRouteInfo = (req, res) => {
  res.json({
    service: "claw-in-a-box",
    endpoint: req.originalUrl,
    usage: "POST JSON to this same path; request schema is documented at /skill.md",
  });
};

async function claimHandler(req, res, next) {
  const agentId = String((req.body || {}).agent_id || "").trim();
  if (!agentId) {
    return res.status(400).json({ error: "missing_field", detail: "agent_id is required" });
  }
  if (agentId.length > 191) {
    return res.status(400).json({ error: "invalid_agent_id", detail: "agent_id must be at most 191 characters" });
  }
  const payer = String(payerForRequest(req) || "");
  if (!payer) {
    return res.status(502).json({ error: "payer_unavailable", detail: "verified payment did not identify its payer wallet" });
  }
  const agentSecret = newAgentSecret();
  const claimedAt = new Date().toISOString();
  try {
    const transaction = await persistence.beginClaim(agentId, secretHash(agentSecret), claimedAt);
    transaction.verifiedPayer = payer;
    req._claimTransaction = transaction;
    res.once("close", () => {
      if (req._claimTransaction) {
        persistence.rollbackClaim(req._claimTransaction).finally(() => {
          req._claimTransaction = null;
        });
      }
    });
    return res.status(201).json({
      agent_id: agentId,
      agent_secret: agentSecret,
      claimed_at: claimedAt,
      claimed_by: payer,
    });
  } catch (error) {
    return next(error);
  }
}

app.post("/paid/v1/guard/check", guardCheckHandler);
app.get("/paid/v1/guard/check", paidRouteInfo);
app.post("/paid/v1/tokens/verify", (req, res) => {
  const b = req.body || {};
  res.json({
    valid: true,
    context: verifyToken(need(b, "token"), b.presenter ? String(b.presenter) : null),
  });
});
app.get("/paid/v1/tokens/verify", paidRouteInfo);
app.post("/paid/v1/agents/claim", claimHandler);
app.get("/paid/v1/agents/claim", claimHandler);
// v0.7.1 OKX-rail mirrors (payment enforced by the OKX SDK middleware above)
app.post("/paid-okx/v1/guard/check", guardCheckHandler);
app.get("/paid-okx/v1/guard/check", paidRouteInfo);
app.post("/paid-okx/v1/tokens/verify", (req, res) => {
  const b = req.body || {};
  res.json({
    valid: true,
    context: verifyToken(need(b, "token"), b.presenter ? String(b.presenter) : null),
  });
});
app.get("/paid-okx/v1/tokens/verify", paidRouteInfo);
app.post("/paid-okx/v1/agents/claim", claimHandler);
app.get("/paid-okx/v1/agents/claim", claimHandler);

app.post("/v1/agents/rotate", rateLimit, async (req, res, next) => {
  if (!persistence.hardReady()) {
    return res.status(503).json({ error: "feature_disabled", detail: "secret rotation requires a connected, hydrated database" });
  }
  const agentId = String((req.body || {}).agent_id || "").trim();
  if (!agentId) {
    return res.status(400).json({ error: "missing_field", detail: "agent_id is required" });
  }
  const claimed = claimedAgents.get(agentId);
  if (!claimed) return res.status(404).json({ error: "not_found", detail: "agent_id is not claimed" });
  const presented = req.get("X-Agent-Secret") || "";
  if (!secretsEqual(presented, claimed.secret_hash)) {
    return res.status(403).json({ error: "forbidden", detail: "agent secret is invalid" });
  }
  const replacement = newAgentSecret();
  const replacementHash = secretHash(replacement);
  try {
    await persistence.rotateAgent(agentId, claimed.secret_hash, replacementHash);
    claimed.secret_hash = replacementHash;
    claimedAgents.set(agentId, claimed);
    return res.json({ agent_secret: replacement });
  } catch (error) {
    return next(error);
  }
});

app.post("/v1/agents/strict", rateLimit, async (req, res, next) => {
  if (!persistence.hardReady()) {
    return res.status(503).json({ error: "feature_disabled", detail: "strict mode requires a connected, hydrated database" });
  }
  const body = req.body || {};
  const agentId = String(body.agent_id || "").trim();
  if (!agentId) {
    return res.status(400).json({ error: "missing_field", detail: "agent_id is required" });
  }
  if (typeof body.strict !== "boolean") {
    return res.status(400).json({ error: "invalid_field", detail: "strict must be true or false" });
  }
  const claimed = claimedAgents.get(agentId);
  if (!claimed) return res.status(404).json({ error: "not_found", detail: "agent_id is not claimed" });
  const presented = req.get("X-Agent-Secret") || "";
  if (!secretsEqual(presented, claimed.secret_hash)) {
    return res.status(403).json({ error: "forbidden", detail: "agent secret is invalid" });
  }
  const previousStrictMode = claimed.strict_mode;
  try {
    await persistence.setStrictMode(agentId, claimed.secret_hash, body.strict);
    claimed.strict_mode = body.strict;
    claimedAgents.set(agentId, claimed);
    persistence.audit("binding_changed", agentId, agentId, {
      change: "strict_mode",
      previous_strict_mode: previousStrictMode,
      strict_mode: body.strict,
    });
    return res.json({ agent_id: agentId, strict_mode: body.strict });
  } catch (error) {
    return next(error);
  }
});

// Multi-tenant: a caller registers to receive THEIR agent's review requests
// on THEIR own Telegram. Returns a one-time code; the caller sends
// "/bind CODE" to the bot to complete the link.
app.post("/v1/operators/register", rateLimit, (req, res) => {
  const agentId = String((req.body || {}).agent_id || "").trim();
  if (!agentId) {
    return res.status(400).json({ error: "missing_field", detail: "agent_id is required" });
  }
  requireAgentSecret(req, agentId);
  if (!TG_ENABLED) {
    return res.status(503).json({ error: "telegram_disabled", detail: "operator approval is not configured on this deployment" });
  }
  const code = newBindCode();
  pendingBinds.set(code, { agent_id: agentId, created: Date.now() });
  setTimeout(() => pendingBinds.delete(code), BIND_TTL_MS).unref();
  res.json({
    agent_id: agentId,
    bind_code: code,
    expires_in_seconds: BIND_TTL_MS / 1000,
    instructions: `Open Telegram, message the Claw-in-a-Box bot, and send:  /bind ${code}`,
    note: "Until you bind, review requests for this agent go to the service operator by default.",
  });
});

// Inspect who a given agent's reviews route to (bound caller vs operator)
app.get("/v1/operators/:agent_id", (req, res) => {
  const bound = operatorBindings.has(String(req.params.agent_id));
  res.json({ agent_id: req.params.agent_id, routing: bound ? "caller" : "operator" });
});

app.get("/v1/policies", (req, res) => {
  res.json({ presets: Object.values(PRESETS) });
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found", detail: `no route ${req.path}` });
});

app.use((err, req, res, _next) => {
  const status = err.status || (err.type === "entity.parse.failed" ? 400 : 500);
  const code = err.code || (status === 400 ? "invalid_token" : "internal");
  res.status(status).json({
    error: code,
    detail: err.message,
    ...(status === 403 ? { valid: false, verdict: "deny" } : {}),
  });
});

function restoreApproval(id, row) {
  const a = { ...row, waiters: [] };
  approvals.set(id, a);
  // Re-arm the expiry timer with whatever time the approval has left; an
  // approval that expired while we were down is resolved immediately.
  const elapsed = Date.now() - new Date(a.created_at).getTime();
  armApprovalExpiry(id, APPROVAL_TIMEOUT_S * 1000 - elapsed);
}

function restoreVerdict(row) {
  const issuedAtMs = new Date(row.issued_at).getTime();
  const verdict = {
    id: String(row.id),
    agent_id: String(row.agent_id),
    amount: Number(row.amount),
    day: String(row.day),
    status: "pending",
    issued_at: String(row.issued_at),
    expires_at_ms: Number.isFinite(issuedAtMs) ? issuedAtMs + VERDICT_TTL_S * 1000 : 0,
    consumed_at: null,
  };
  verdicts.set(verdict.id, verdict);
  armVerdictExpiry(verdict);
}

function restoreClaimedAgent(row) {
  claimedAgents.set(String(row.agent_id), {
    agent_id: String(row.agent_id),
    secret_hash: String(row.secret_hash),
    claimed_at: String(row.claimed_at),
    claimed_by: row.claimed_by == null ? null : String(row.claimed_by),
    strict_mode: Boolean(Number(row.strict_mode)),
  });
}

app.listen(PORT, () => {
  console.log(`claw-in-a-box listening on :${PORT}`);
  if (initX402) initX402(); // x402 SDK sync must happen after the server is up
  if (initCdp) initCdp();   // ditto for the CDP layer (api host)
  persistence.init().then(() =>
    persistence.hydrate({
      revoked,
      dailySpend,
      operatorBindings,
      restoreApproval,
      restoreVerdict,
      restoreClaimedAgent,
    })
  ).then(() => sweep());
});
