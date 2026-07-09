// SPDX-License-Identifier: Apache-2.0
// Claw-in-a-Box — delegatable capability tokens + spend-policy verdicts
// for AI agents. Zero-dependency Node.js (>=18). See SKILL.md for the API.
//
//   PORT=8787 GUARD_SECRET=change-me node server.js

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8787);
const SECRET = Buffer.from(process.env.GUARD_SECRET || "claw-in-a-box-dev-secret");
const DEFAULT_TTL_S = 3600;

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

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function guardError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = code === "invalid_token" || code === "invalid_signature" ? 400 : 403;
  return err;
}

const json = (res, status, obj) => {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 65536) reject(guardError("invalid_token", "body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(guardError("invalid_token", "body is not valid JSON"));
      }
    });
  });

const need = (body, field) => {
  const v = body[field];
  if (v === undefined || v === null || v === "") {
    throw guardError("missing_field", `field '${field}' is required`);
  }
  return v;
};

const routes = {
  "POST /v1/tokens": (b) => ({
    token: issueRoot(String(need(b, "subject")), need(b, "scopes"), Number(b.ttl_seconds)),
  }),
  "POST /v1/tokens/delegate": (b) => ({
    token: delegateToken(
      need(b, "parent_token"),
      String(need(b, "audience")),
      need(b, "scopes"),
      Number(b.ttl_seconds)
    ),
  }),
  "POST /v1/tokens/verify": (b) => ({
    valid: true,
    context: verifyToken(need(b, "token"), b.presenter ? String(b.presenter) : null),
  }),
  "POST /v1/tokens/revoke": (b) => revokeToken(need(b, "token")),
  "POST /v1/guard/check": (b) => guardCheck(b),
  "GET /v1/policies": () => ({ presets: Object.values(PRESETS) }),
};

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.method === "GET" && (url === "/" || url === "/healthz")) {
      return json(res, 200, { ok: true, service: "claw-in-a-box", version: "0.1.0" });
    }
    if (req.method === "GET" && url === "/skill.md") {
      const md = fs.readFileSync(path.join(__dirname, "SKILL.md"));
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      return res.end(md);
    }
    const handler = routes[`${req.method} ${url}`];
    if (!handler) return json(res, 404, { error: "not_found", detail: `no route ${url}` });
    const body = req.method === "POST" ? await readBody(req) : {};
    return json(res, 200, handler(body));
  } catch (err) {
    const status = err.status || 500;
    return json(res, status, {
      error: err.code || "internal",
      detail: err.message,
      ...(status === 403 ? { valid: false, verdict: "deny" } : {}),
    });
  }
});

server.listen(PORT, () => {
  console.log(`claw-in-a-box listening on :${PORT}`);
});
