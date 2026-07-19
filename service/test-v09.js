// SPDX-License-Identifier: Apache-2.0
// v0.9.0 integration tests: DB-only reads, operator bearer auth, spend history,
// aggregate metrics, EIP-191 recovery, rate metadata, CORS, and fail-closed gates.
"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts");

let fails = 0;
let passes = 0;
const ok = (name, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` -> ${detail}` : ""}`);
  if (condition) passes++;
  else fails++;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const preload = path.join(__dirname, "test", "mysql-preload.js");
const secretHash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function boot(env, port) {
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" ");
  return spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), NODE_OPTIONS: nodeOptions, ...env },
    stdio: process.env.CLAW_TEST_VERBOSE === "1" ? "inherit" : "ignore",
  });
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(1000)]);
}

async function waitReady(port, requireDb = false) {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      const body = await response.json();
      if (!requireDb || body.features?.persistence?.hydrated === true) return body;
    } catch {}
    await delay(100);
  }
  throw new Error(`server ${port} did not become ready`);
}

const request = (port, route, { method = "GET", body, headers = {} } = {}) => fetch(
  `http://127.0.0.1:${port}${route}`,
  {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
);
const post = (port, route, body, headers = {}) => request(port, route, { method: "POST", body, headers });

function emptyDb() {
  return {
    revoked_tokens: {}, daily_spend: {}, approvals: {}, operator_bindings: {},
    agents: {}, verdicts: {}, events: [], next_event_id: 1,
    spend_ledger: [], next_spend_id: 1, recovery_nonces: {},
  };
}

function seedDb(file, owner, ownerSecret, other, otherSecret) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const data = emptyDb();
  data.agents.owner = {
    agent_id: "owner", secret_hash: secretHash(ownerSecret), claimed_at: now.toISOString(),
    claimed_by: owner.address, strict_mode: 0,
  };
  data.agents.other = {
    agent_id: "other", secret_hash: secretHash(otherSecret), claimed_at: now.toISOString(),
    claimed_by: other.address, strict_mode: 1,
  };
  data.daily_spend.owner = { agent_id: "owner", day: today, spent: 31 };
  for (let i = 1; i <= 55; i++) {
    data.spend_ledger.push({
      id: i, agent_id: "owner", day: today, delta: 1, spent_after: i,
      reason: "guard_allow", ref_id: null,
      created_at: new Date(now.getTime() - (55 - i) * 1000).toISOString(),
    });
  }
  data.next_spend_id = 56;
  const pendingPayload = {
    id: "feed-pending", status: "pending", final_verdict: null,
    request: { agent_id: "private-agent", action: "spend", amount: 150, destination: "private-destination" },
    created_at: new Date(now.getTime() - 1000).toISOString(), resolved_at: null,
  };
  const approvedPayload = {
    id: "feed-approved", status: "approved", final_verdict: "allow",
    request: { agent_id: "older-agent", action: "spend", amount: 5, destination: null },
    created_at: new Date(now.getTime() - 5000).toISOString(), resolved_at: now.toISOString(),
  };
  data.approvals["feed-pending"] = { id: "feed-pending", status: "pending", payload: pendingPayload };
  data.approvals["feed-approved"] = { id: "feed-approved", status: "approved", payload: approvedPayload };
  data.events.push(
    { id: 1, ts: now.toISOString(), type: "approval_resolved", agent_id: "private-agent", ref_id: "a", payload: { status: "approved" } },
    { id: 2, ts: now.toISOString(), type: "verdict_consumed", agent_id: "private-agent", ref_id: "v", payload: {} },
  );
  data.next_event_id = 3;
  fs.writeFileSync(file, JSON.stringify(data));
}

function envFor(file, extra = {}) {
  return {
    PAYMENT_MODE: "off",
    PERSISTENCE: "on",
    CLAW_TEST_DB_FILE: file,
    API_HOST: "api.test",
    OPERATOR_BEARER_KEY: "operator-test-key",
    RATE_MAX: "1000",
    RECOVERY_TTL_MS: "2000",
    RECOVERY_ISSUE_IP_MAX: "100",
    RECOVERY_ISSUE_AGENT_MAX: "100",
    RECOVERY_VERIFY_IP_MAX: "100",
    ...extra,
  };
}

function rateHeaders(response) {
  return ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"]
    .every((name) => response.headers.has(name));
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-v09-"));
  const dbFile = path.join(temp, "db.json");
  const owner = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const ownerSecret = "owner-secret-before-recovery";
  const otherSecret = "other-agent-secret";
  seedDb(dbFile, owner, ownerSecret, other, otherSecret);

  let server = boot(envFor(dbFile), 8840);
  let restartChallenge;
  let domainChallenge;
  try {
    const health = await waitReady(8840, true);
    ok("healthz reports v0.9.0", health.version === "0.9.0", `version=${health.version}`);
    ok("healthz reports operator auth + EOA recovery", health.features?.operator_auth_configured === true && health.features?.wallet_recovery === "eoa-eip191");

    let response = await request(8840, "/v1/metrics", { method: "OPTIONS", headers: {
      origin: "https://console.example", "access-control-request-headers": "authorization",
    } });
    ok("CORS keeps wildcard origin without credential mode",
      response.status === 204 && response.headers.get("access-control-allow-origin") === "*" &&
      !response.headers.has("access-control-allow-credentials"));
    ok("CORS adds only authorization to the existing allow-header contract",
      response.headers.get("access-control-allow-headers") ===
      "content-type, x-agent-secret, payment-signature, x-payment, authorization");
    ok("CORS exposes retry and informational rate headers",
      String(response.headers.get("access-control-expose-headers")).includes("RateLimit-Remaining") &&
      String(response.headers.get("access-control-expose-headers")).includes("Retry-After"));

    // NANDA five: bodies retain their exact top-level contracts while rate metadata is header-only.
    response = await post(8840, "/v1/tokens", { subject: "nanda", scopes: ["read"] });
    const minted = await response.json();
    const root = minted.token;
    const nandaResults = [{ response, body: minted, keys: ["token"] }];
    response = await post(8840, "/v1/tokens/delegate", { parent_token: root, audience: "child", scopes: ["read"] });
    nandaResults.push({ response, body: await response.json(), keys: ["token"] });
    response = await post(8840, "/v1/tokens/verify", { token: root });
    nandaResults.push({ response, body: await response.json(), keys: ["context", "valid"] });
    response = await post(8840, "/v1/guard/check", { agent_id: "nanda-v09", amount: 1 });
    nandaResults.push({ response, body: await response.json(), keys: [
      "agent_id", "evaluated_at", "policy_used", "reasons", "spent_today_after", "triggered_rules", "verdict",
    ] });
    response = await post(8840, "/v1/tokens/revoke", { token: root });
    nandaResults.push({ response, body: await response.json(), keys: ["cascades", "revoked_tid"] });
    ok("NANDA five remain free and successful", nandaResults.every((item) => item.response.status === 200));
    ok("NANDA five response bodies remain byte-contract stable",
      nandaResults.every((item) => JSON.stringify(Object.keys(item.body).sort()) === JSON.stringify(item.keys.slice().sort())));
    ok("NANDA five receive informational RateLimit headers only", nandaResults.every((item) => rateHeaders(item.response)));

    response = await request(8840, "/v1/approvals");
    ok("approval god-view rejects missing bearer", response.status === 401 && response.headers.get("www-authenticate") === "Bearer");
    response = await request(8840, "/v1/approvals", { headers: { "X-Agent-Secret": ownerSecret } });
    ok("agent secret cannot access approval god-view", response.status === 401);
    response = await request(8840, "/v1/approvals?status=pending&limit=1", {
      headers: { authorization: "Bearer operator-test-key" },
    });
    const feed = await response.json();
    ok("operator bearer lists filtered live approvals",
      response.status === 200 && feed.count === 1 && feed.approvals[0]?.approval_id === "feed-pending" &&
      response.headers.get("cache-control") === "no-store");
    response = await request(8840, "/v1/approvals?status=anything", {
      headers: { authorization: "Bearer operator-test-key" },
    });
    ok("approval list validates status", response.status === 400);
    response = await request(8840, "/v1/approvals?limit=101", {
      headers: { authorization: "Bearer operator-test-key" },
    });
    ok("approval list validates bounded limit", response.status === 400);

    response = await request(8840, "/v1/agents/owner/spend");
    ok("spend view rejects missing owner secret", response.status === 403);
    response = await request(8840, "/v1/agents/owner/spend", { headers: { "X-Agent-Secret": otherSecret } });
    ok("spend view rejects another agent's secret", response.status === 403);
    response = await request(8840, "/v1/agents/owner/spend", { headers: { "X-Agent-Secret": ownerSecret } });
    const spend = await response.json();
    ok("owner spend view returns current total + fixed last 50",
      response.status === 200 && spend.spent_today === 31 && spend.history.length === 50 &&
      spend.history[0].id === "55" && spend.history_scope === "v0.9_forward_last_50");
    ok("spend history is PII-minimized",
      spend.history.every((row) => !Object.hasOwn(row, "destination") && !Object.hasOwn(row, "policy")) &&
      !JSON.stringify(spend).includes(owner.address));
    response = await request(8840, "/v1/agents/unclaimed/spend", { headers: { "X-Agent-Secret": ownerSecret } });
    ok("unclaimed spend view returns 404", response.status === 404);

    response = await request(8840, "/v1/metrics");
    const metrics = await response.json();
    const metricsText = JSON.stringify(metrics);
    ok("public metrics return fixed aggregate schema",
      response.status === 200 && metrics.agents?.claimed === 2 && metrics.agents?.strict === 1 &&
      metrics.approvals?.pending === 1 && metrics.spend?.active_agents_today >= 1);
    ok("public metrics contain no PII or individual amounts",
      !metricsText.includes("private-agent") && !metricsText.includes("private-destination") &&
      !metricsText.includes(owner.address) && !metricsText.includes("amount"));
    const generatedAt = metrics.generated_at;
    const cached = await (await request(8840, "/v1/metrics")).json();
    ok("public metrics use the 15-second cache", cached.generated_at === generatedAt);

    // Successful recovery rotates, never reveals, the old secret.
    response = await post(8840, "/v1/agents/recover", { agent_id: "owner" });
    const challenge = await response.json();
    ok("recovery issues a five-minute-style domain-bound EIP-191 challenge",
      response.status === 200 && challenge.message.includes("Domain: api.test") &&
      challenge.message.includes(`Nonce: ${challenge.nonce}`) && response.headers.get("cache-control") === "no-store");
    const persistedAfterIssue = fs.readFileSync(dbFile, "utf8");
    ok("recovery DB stores nonce hash, not raw nonce", !persistedAfterIssue.includes(challenge.nonce));
    const signature = await owner.signMessage({ message: challenge.message });
    response = await post(8840, "/v1/agents/recover", { agent_id: "owner", nonce: challenge.nonce, signature });
    const recovered = await response.json();
    ok("claim wallet recovery returns one fresh secret", response.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(recovered.agent_secret || ""));
    response = await post(8840, "/v1/agents/strict", { agent_id: "owner", strict: false }, { "X-Agent-Secret": ownerSecret });
    ok("recovery invalidates the old secret", response.status === 403);
    response = await post(8840, "/v1/agents/strict", { agent_id: "owner", strict: false }, { "X-Agent-Secret": recovered.agent_secret });
    ok("recovered one-time secret authenticates", response.status === 200);
    response = await post(8840, "/v1/agents/recover", { agent_id: "owner", nonce: challenge.nonce, signature });
    ok("recovery nonce replay returns 409", response.status === 409);

    response = await post(8840, "/v1/agents/recover", { agent_id: "owner" });
    const wrongChallenge = await response.json();
    const wrongSignature = await other.signMessage({ message: wrongChallenge.message });
    response = await post(8840, "/v1/agents/recover", {
      agent_id: "owner", nonce: wrongChallenge.nonce, signature: wrongSignature,
    });
    ok("recovery rejects a different EOA", response.status === 403);

    response = await post(8840, "/v1/agents/recover", { agent_id: "owner" });
    const tamperChallenge = await response.json();
    const tamperedSignature = await owner.signMessage({ message: `${tamperChallenge.message}\ntampered` });
    response = await post(8840, "/v1/agents/recover", {
      agent_id: "owner", nonce: tamperChallenge.nonce, signature: tamperedSignature,
    });
    ok("recovery rejects a tampered canonical message", response.status === 403);

    response = await post(8840, "/v1/agents/recover", { agent_id: "owner" });
    const expiredChallenge = await response.json();
    const expiredSignature = await owner.signMessage({ message: expiredChallenge.message });
    await delay(2100);
    response = await post(8840, "/v1/agents/recover", {
      agent_id: "owner", nonce: expiredChallenge.nonce, signature: expiredSignature,
    });
    ok("recovery rejects an expired nonce", response.status === 410);

    response = await post(8840, "/v1/agents/recover", { agent_id: "owner" });
    const raceChallenge = await response.json();
    const raceSignature = await owner.signMessage({ message: raceChallenge.message });
    const raced = await Promise.all([
      post(8840, "/v1/agents/recover", { agent_id: "owner", nonce: raceChallenge.nonce, signature: raceSignature }),
      post(8840, "/v1/agents/recover", { agent_id: "owner", nonce: raceChallenge.nonce, signature: raceSignature }),
    ]);
    ok("concurrent recovery replay yields exactly one success",
      JSON.stringify(raced.map((item) => item.status).sort()) === JSON.stringify([200, 409]));

    response = await post(8840, "/v1/agents/recover", { agent_id: "owner" });
    restartChallenge = await response.json();
    response = await post(8840, "/v1/agents/recover", { agent_id: "owner" });
    domainChallenge = await response.json();
  } finally {
    await stop(server);
  }

  // Challenge rows survive restart and expired rows are swept on boot.
  server = boot(envFor(dbFile), 8840);
  try {
    await waitReady(8840, true);
    const restartSignature = await owner.signMessage({ message: restartChallenge.message });
    let response = await post(8840, "/v1/agents/recover", {
      agent_id: "owner", nonce: restartChallenge.nonce, signature: restartSignature,
    });
    ok("recovery challenge survives restart and remains usable", response.status === 200);
    await delay(200);
    const db = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    ok("boot sweep removes expired recovery nonce rows",
      !Object.values(db.recovery_nonces).some((row) => Number(row.expires_at_ms) < Date.now()));
    const auditText = JSON.stringify(db.events);
    ok("recovery lifecycle is audited without proof material",
      db.events.some((event) => event.type === "recovery_challenge_issued") &&
      db.events.some((event) => event.type === "agent_secret_recovered") &&
      db.events.some((event) => event.type === "agent_recovery_failed") &&
      !auditText.includes(restartChallenge.nonce) && !auditText.includes(restartSignature));
  } finally { await stop(server); }

  server = boot(envFor(dbFile, { API_HOST: "other.test" }), 8840);
  try {
    await waitReady(8840, true);
    const domainSignature = await owner.signMessage({ message: domainChallenge.message });
    const response = await post(8840, "/v1/agents/recover", {
      agent_id: "owner", nonce: domainChallenge.nonce, signature: domainSignature,
    });
    ok("recovery challenge cannot replay across API_HOST domains", response.status === 404);
  } finally { await stop(server); }

  // Env-tunable recovery admission limits expose Retry-After.
  const rateDb = path.join(temp, "rate.json");
  seedDb(rateDb, owner, ownerSecret, other, otherSecret);
  server = boot(envFor(rateDb, {
    RECOVERY_ISSUE_IP_MAX: "2", RECOVERY_ISSUE_AGENT_MAX: "2", RECOVERY_VERIFY_IP_MAX: "1",
  }), 8841);
  try {
    await waitReady(8841, true);
    await post(8841, "/v1/agents/recover", { agent_id: "owner" });
    await post(8841, "/v1/agents/recover", { agent_id: "owner" });
    const limited = await post(8841, "/v1/agents/recover", { agent_id: "owner" });
    ok("recovery issue throttle returns 429 + Retry-After", limited.status === 429 && Number(limited.headers.get("retry-after")) > 0);
  } finally { await stop(server); }

  // Every new DB-backed surface fails closed; no memory fallback.
  const deadDb = path.join(temp, "dead.json");
  server = boot(envFor(deadDb, { CLAW_TEST_DB_FAIL: "1" }), 8842);
  try {
    await waitReady(8842);
    let response = await request(8842, "/v1/approvals", { headers: { authorization: "Bearer operator-test-key" } });
    ok("DB-down approval list fails closed", response.status === 503);
    response = await request(8842, "/v1/agents/owner/spend", { headers: { "X-Agent-Secret": ownerSecret } });
    ok("DB-down spend view fails closed", response.status === 503);
    response = await request(8842, "/v1/metrics");
    ok("DB-down metrics fail closed", response.status === 503);
    response = await post(8842, "/v1/agents/recover", { agent_id: "owner" });
    ok("DB-down recovery fails closed", response.status === 503);
  } finally { await stop(server); }

  const noOperatorDb = path.join(temp, "no-operator.json");
  seedDb(noOperatorDb, owner, ownerSecret, other, otherSecret);
  server = boot(envFor(noOperatorDb, { OPERATOR_BEARER_KEY: "" }), 8843);
  try {
    await waitReady(8843, true);
    const response = await request(8843, "/v1/approvals", { headers: { authorization: "Bearer anything" } });
    ok("missing operator env fails closed", response.status === 503);
  } finally { await stop(server); }

  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  ok("operator bearer comparison hashes equal-length buffers and uses timingSafeEqual",
    source.includes("bearerKeysEqual") && source.includes("crypto.timingSafeEqual(candidate, configured)"));
  ok("claim duplicate normalization includes MySQL integrity SQLSTATE",
    fs.readFileSync(path.join(__dirname, "storage.js"), "utf8").includes('error.sqlState === "23000"'));

  console.log(fails === 0
    ? `\nALL v0.9.0 TESTS PASSED (${passes} checks)`
    : `\n${fails} v0.9.0 FAILURE(S); ${passes} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
