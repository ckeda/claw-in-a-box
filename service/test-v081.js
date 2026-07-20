// SPDX-License-Identifier: Apache-2.0
// v0.8.1 integration tests: Pay-to-Claim, strict identity, execution binding,
// audit events, fail-closed persistence and restart survival.
"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

let fails = 0;
const ok = (name, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` -> ${detail}` : ""}`);
  if (!condition) fails++;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const preload = path.join(__dirname, "test", "mysql-preload.js");

function boot(env, port) {
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" ");
  return spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), NODE_OPTIONS: nodeOptions, ...env },
    stdio: process.env.CLAW_TEST_VERBOSE === "1" ? "inherit" : "ignore",
  });
}

const post = (port, route, body, headers = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const get = (port, route, headers = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
  headers,
});

const hostRequest = (port, route, body, headers = {}, method = "POST") => new Promise((resolve, reject) => {
  const hasBody = body !== undefined;
  const request = http.request({
    host: "127.0.0.1",
    port,
    method,
    path: route,
    headers: { host: "api.test", ...(hasBody ? { "content-type": "application/json" } : {}), ...headers },
  }, (response) => {
    let text = "";
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => resolve({
      status: response.statusCode,
      headers: response.headers,
      text,
      json: () => { try { return JSON.parse(text); } catch { return {}; } },
    }));
  });
  request.on("error", reject);
  request.end(hasBody ? JSON.stringify(body) : undefined);
});

async function waitReady(port, requireDb = false) {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      const body = await response.json();
      if (!requireDb || body.features?.persistence?.hydrated === true) return body;
    } catch {}
    await delay(100);
  }
  throw new Error(`server ${port} did not become ready`);
}

async function waitCdpReady(port) {
  for (let i = 0; i < 60; i++) {
    const health = await waitReady(port, true);
    if (health.features?.cdp_x402_ready === true) return health;
    await delay(100);
  }
  throw new Error(`CDP layer on ${port} did not become ready`);
}

async function challenge(port, route) {
  const response = await post(port, route, { agent_id: "challenge" });
  const encoded = response.headers.get("payment-required");
  return { response, envelope: encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : null };
}

const paymentHeader = (accepts) => ({
  "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: accepts,
    payload: { signature: "0xmock", authorization: {} },
  })).toString("base64"),
});

function startFacilitator(port) {
  const hits = { verify: 0, settle: 0 };
  const payer = "0x3333333333333333333333333333333333333333";
  let settlementPayer = payer;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/v6/pay/x402/supported")) {
      return res.end(JSON.stringify({ code: 0, data: { kinds: [
        { x402Version: 2, network: "eip155:196", scheme: "exact" },
      ] } }));
    }
    if (req.url.startsWith("/api/v6/pay/x402/verify")) {
      hits.verify++;
      return res.end(JSON.stringify({ code: 0, data: { isValid: true, payer } }));
    }
    if (req.url.startsWith("/api/v6/pay/x402/settle")) {
      hits.settle++;
      return res.end(JSON.stringify({ code: 0, data: {
        success: true,
        status: "success",
        transaction: `0x${"ef".repeat(32)}`,
        network: "eip155:196",
        amount: "10000",
        payer: settlementPayer,
      } }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(port);
  return {
    server,
    hits,
    payer,
    setSettlementPayer(value) { settlementPayer = value; },
  };
}

function dbEnv(dbFile, facilitatorPort, extra = {}) {
  return {
    PAYMENT_MODE: "okx-x402",
    PERSISTENCE: "on",
    CLAW_TEST_DB_FILE: dbFile,
    X402_PAY_TO: "0x0361af173cae66337f3f05abdbb2b68e5c88ccfd",
    X402_FACILITATOR_URL: `http://127.0.0.1:${facilitatorPort}`,
    OKX_API_KEY: "test-key",
    OKX_SECRET_KEY: "test-secret",
    OKX_PASSPHRASE: "test-passphrase",
    TELEGRAM_BOT_TOKEN: "0:test",
    TELEGRAM_CHAT_ID: "1",
    APPROVAL_TIMEOUT_S: "60",
    VERDICT_TTL_S: "1",
    ...extra,
  };
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(1000)]);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-v081-"));
  const dbFile = path.join(temp, "db.json");
  const facilitator = startFacilitator(9921);
  const env = dbEnv(dbFile, 9921);
  let server = boot(env, 8831);
  await waitReady(8831, true);

  let alphaSecret;
  let rotatedSecret;
  let pendingApprovalId;
  let revokedToken;
  try {
    let response = await get(8831, "/paid/v1/agents/claim");
    let required = response.headers.get("payment-required");
    let envelope = required ? JSON.parse(Buffer.from(required, "base64").toString("utf8")) : null;
    ok("GET claim discovery probe without payment -> 402", response.status === 402 && Boolean(envelope?.accepts?.[0]));
    const settledBeforePaidGet = facilitator.hits.settle;
    response = await get(8831, "/paid/v1/agents/claim", paymentHeader(envelope.accepts[0]));
    const invalidPaidGet = await response.json();
    await delay(100);
    const healthAfterPaidGet = await (await get(8831, "/healthz")).json();
    ok("paid GET claim rejects missing agent_id before settlement",
      response.status === 400 && invalidPaidGet.error === "missing_field" &&
      facilitator.hits.settle === settledBeforePaidGet && healthAfterPaidGet.memory?.claimed_agents === 0,
      `status=${response.status} settle=${facilitator.hits.settle} claimed=${healthAfterPaidGet.memory?.claimed_agents}`);

    response = await get(8831, "/paid-okx/v1/agents/claim");
    required = response.headers.get("payment-required");
    envelope = required ? JSON.parse(Buffer.from(required, "base64").toString("utf8")) : null;
    ok("GET /paid-okx claim discovery probe without payment -> 402",
      response.status === 402 && Boolean(envelope?.accepts?.[0]));
    const settledBeforeMirrorPaidGet = facilitator.hits.settle;
    response = await get(8831, "/paid-okx/v1/agents/claim", paymentHeader(envelope.accepts[0]));
    const invalidMirrorPaidGet = await response.json();
    await delay(100);
    const healthAfterMirrorPaidGet = await (await get(8831, "/healthz")).json();
    ok("paid GET /paid-okx claim rejects before settlement",
      response.status === 400 && invalidMirrorPaidGet.error === "missing_field" &&
      facilitator.hits.settle === settledBeforeMirrorPaidGet && healthAfterMirrorPaidGet.memory?.claimed_agents === 0,
      `status=${response.status} settle=${facilitator.hits.settle} claimed=${healthAfterMirrorPaidGet.memory?.claimed_agents}`);

    const claimChallenge = await challenge(8831, "/paid/v1/agents/claim");
    ok("claim without payment -> 402", claimChallenge.response.status === 402);
    const header = paymentHeader(claimChallenge.envelope.accepts[0]);

    response = await post(8831, "/paid/v1/agents/claim", { agent_id: "alpha" }, header);
    const firstClaim = await response.json();
    alphaSecret = firstClaim.agent_secret;
    ok("claim first call -> 201 + 32-byte base64url secret", response.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(alphaSecret || ""));
    ok("claim anchors facilitator payer", firstClaim.claimed_by === facilitator.payer);
    ok("claim response identifies the claimed agent", firstClaim.agent_id === "alpha" && Boolean(firstClaim.claimed_at));
    const settledAfterClaim = facilitator.hits.settle;

    response = await post(8831, "/paid/v1/agents/claim", { agent_id: "alpha" }, header);
    const duplicate = await response.json();
    await delay(100);
    ok("duplicate claim -> 409 without returning secret", response.status === 409 && duplicate.error === "already_claimed" && !("agent_secret" in duplicate));
    ok("duplicate claim never settles", facilitator.hits.settle === settledAfterClaim);

    const mirrorChallenge = await challenge(8831, "/paid-okx/v1/agents/claim");
    response = await post(8831, "/paid-okx/v1/agents/claim", { agent_id: "okx-mirror" },
      paymentHeader(mirrorChallenge.envelope.accepts[0]));
    const mirrorClaim = await response.json();
    ok("/paid-okx claim mirror settles and claims", response.status === 201 && mirrorClaim.claimed_by === facilitator.payer);

    const beforeRaceSettle = facilitator.hits.settle;
    const raced = await Promise.all([
      post(8831, "/paid/v1/agents/claim", { agent_id: "raced-id" }, header),
      post(8831, "/paid/v1/agents/claim", { agent_id: "raced-id" }, header),
    ]);
    const raceStatuses = raced.map((item) => item.status).sort();
    await delay(100);
    ok("concurrent first-claim race yields one 201 and one pre-settle 409",
      JSON.stringify(raceStatuses) === JSON.stringify([201, 409]));
    ok("concurrent first-claim race settles exactly once", facilitator.hits.settle === beforeRaceSettle + 1);

    const settlementPayer = "0x5555555555555555555555555555555555555555";
    facilitator.setSettlementPayer(settlementPayer);
    const mismatchChallenge = await challenge(8831, "/paid/v1/agents/claim");
    response = await post(8831, "/paid/v1/agents/claim", { agent_id: "payer-mismatch" },
      paymentHeader(mismatchChallenge.envelope.accepts[0]));
    const mismatchClaim = await response.json();
    facilitator.setSettlementPayer(facilitator.payer);
    ok("payer mismatch keeps the paid claim and returns provisional verified payer",
      response.status === 201 && mismatchClaim.claimed_by === facilitator.payer);
    await delay(100);
    const mismatchHealth = await (await fetch("http://127.0.0.1:8831/healthz")).json();
    ok("payer mismatch increments healthz counter", mismatchHealth.counters?.claim_payer_mismatch === 1);
    const mismatchPersisted = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    ok("settlement payer is durable claimed_by ground truth",
      mismatchPersisted.agents["payer-mismatch"]?.claimed_by === settlementPayer);
    const mismatchEvent = mismatchPersisted.events.find((event) => event.type === "claim_payer_mismatch");
    ok("payer mismatch audit records both addresses",
      mismatchEvent?.payload?.verified_payer === facilitator.payer &&
      mismatchEvent?.payload?.settlement_payer === settlementPayer);

    response = await post(8831, "/v1/operators/register", { agent_id: "alpha" });
    ok("claimed register rejects missing secret", response.status === 403);
    response = await post(8831, "/v1/operators/register", { agent_id: "alpha" }, { "X-Agent-Secret": "wrong" });
    ok("claimed register rejects wrong secret", response.status === 403);
    response = await post(8831, "/v1/operators/register", { agent_id: "alpha" }, { "X-Agent-Secret": alphaSecret });
    const registration = await response.json();
    ok("claimed register accepts correct secret", response.status === 200 && Boolean(registration.bind_code));

    response = await post(8831, "/v1/operators/register", { agent_id: "legacy-unclaimed" });
    const legacy = await response.json();
    ok("unclaimed register keeps legacy response contract", response.status === 200 &&
      JSON.stringify(Object.keys(legacy).sort()) === JSON.stringify([
        "agent_id", "bind_code", "expires_in_seconds", "instructions", "note",
      ].sort()) && legacy.agent_id === "legacy-unclaimed" && /^[A-F0-9]{8}$/.test(legacy.bind_code) &&
      legacy.expires_in_seconds === 900 && legacy.instructions.includes(`/bind ${legacy.bind_code}`) &&
      legacy.note === "Until you bind, review requests for this agent go to the service operator by default.");

    response = await post(8831, "/v1/agents/rotate", { agent_id: "alpha" }, { "X-Agent-Secret": alphaSecret });
    const rotated = await response.json();
    rotatedSecret = rotated.agent_secret;
    ok("rotate returns a fresh one-time secret", response.status === 200 && rotatedSecret && rotatedSecret !== alphaSecret);
    response = await post(8831, "/v1/operators/register", { agent_id: "alpha" }, { "X-Agent-Secret": alphaSecret });
    ok("rotated old secret is immediately invalid", response.status === 403);
    response = await post(8831, "/v1/operators/register", { agent_id: "alpha" }, { "X-Agent-Secret": rotatedSecret });
    ok("rotated new secret is valid", response.status === 200);
    ok("secret validation uses timingSafeEqual", fs.readFileSync(path.join(__dirname, "server.js"), "utf8").includes("crypto.timingSafeEqual"));

    response = await post(8831, "/v1/agents/strict", { agent_id: "alpha", strict: true }, { "X-Agent-Secret": "wrong" });
    ok("strict toggle rejects wrong secret", response.status === 403);
    response = await post(8831, "/v1/agents/strict", { agent_id: "alpha", strict: true }, { "X-Agent-Secret": rotatedSecret });
    const strictOn = await response.json();
    ok("strict toggle turns enforcement on", response.status === 200 && strictOn.agent_id === "alpha" && strictOn.strict_mode === true);
    response = await post(8831, "/v1/guard/check", { agent_id: "alpha", amount: 1 });
    ok("strict-on guard requires the secret immediately", response.status === 403);
    response = await post(8831, "/v1/agents/strict", { agent_id: "alpha", strict: false }, { "X-Agent-Secret": rotatedSecret });
    const strictOff = await response.json();
    ok("strict toggle turns enforcement off", response.status === 200 && strictOff.strict_mode === false);
    response = await post(8831, "/v1/guard/check", { agent_id: "alpha", amount: 1 });
    ok("strict-off guard restores open behavior", response.status === 200);
    response = await post(8831, "/v1/agents/strict", { agent_id: "alpha", strict: true }, { "X-Agent-Secret": rotatedSecret });
    ok("strict flag is enabled for restart-survival gate", response.status === 200 && (await response.json()).strict_mode === true);

    response = await post(8831, "/v1/guard/check", { agent_id: "snapshot", amount: 30 });
    const noBind = await response.json();
    const noBindKeys = Object.keys(noBind).sort();
    ok("no-bind guard response is the v0.8 snapshot", JSON.stringify(noBindKeys) === JSON.stringify([
      "agent_id", "evaluated_at", "policy_used", "reasons", "spent_today_after", "triggered_rules", "verdict",
    ].sort()), JSON.stringify(noBindKeys));

    response = await post(8831, "/v1/guard/check", { agent_id: "bound", amount: 30, bind: true });
    const bound = await response.json();
    ok("bind:true allow issues verdict id + expiry", response.status === 200 && /^[a-f0-9]{32}$/.test(bound.verdict_id || "") && bound.expires_in_seconds === 1);
    response = await post(8831, `/v1/verdicts/${bound.verdict_id}/consume`, {});
    const consumed = await response.json();
    ok("verdict consumes exactly once", response.status === 200 && consumed.status === "consumed");
    response = await post(8831, `/v1/verdicts/${bound.verdict_id}/consume`, {});
    const consumedTwice = await response.json();
    ok("second consume -> 409 + first timestamp", response.status === 409 && consumedTwice.error === "already_consumed" && Boolean(consumedTwice.consumed_at));

    response = await post(8831, "/v1/guard/check", { agent_id: "refund", amount: 30, bind: true });
    const expiring = await response.json();
    await delay(1200);
    response = await post(8831, `/v1/verdicts/${expiring.verdict_id}/consume`, {});
    ok("expired verdict consumes as 404", response.status === 404);
    response = await post(8831, "/v1/guard/check", { agent_id: "refund", amount: 1 });
    const afterRefund = await response.json();
    ok("unconsumed same-day verdict refunds its ledger charge", afterRefund.spent_today_after === 1, `spent=${afterRefund.spent_today_after}`);

    response = await post(8831, "/v1/guard/check", { agent_id: "bound-review", amount: 150, bind: true });
    const boundReview = await response.json();
    ok("bind:true review waits for human without an early verdict id", boundReview.verdict === "review" && Boolean(boundReview.approval_id) && !("verdict_id" in boundReview));
    response = await post(8831, "/v1/guard/check", {
      agent_id: "bound-review", amount: 900, policy: { name: "owner-approved", rules: [] },
    });
    ok("spend can change while a human decision is pending", response.status === 200 && (await response.json()).spent_today_after === 900);
    await post(8831, "/telegram/webhook", {
      callback_query: { id: "bound-review-cq", data: `approve:${boundReview.approval_id}` },
    });
    response = await fetch(`http://127.0.0.1:8831/v1/approvals/${boundReview.approval_id}`);
    const approvedBoundReview = await response.json();
    ok("review -> approved issues execution binding", approvedBoundReview.status === "approved" && Boolean(approvedBoundReview.verdict_id));
    response = await post(8831, `/v1/verdicts/${approvedBoundReview.verdict_id}/consume`, {});
    ok("approved review verdict consumes", response.status === 200);
    response = await post(8831, "/v1/guard/check", { agent_id: "bound-review", amount: 1 });
    const afterFinalApproval = await response.json();
    ok("human approval is final even when its charge pushes the day over cap",
      afterFinalApproval.verdict === "deny" && afterFinalApproval.spent_today_after === 1050,
      `verdict=${afterFinalApproval.verdict} spent=${afterFinalApproval.spent_today_after}`);

    response = await post(8831, "/v1/guard/check", { agent_id: "audit-review", amount: 150 });
    const review = await response.json();
    pendingApprovalId = review.approval_id;
    ok("review creates a pending approval for restart gate", Boolean(pendingApprovalId));
    await post(8831, "/telegram/webhook", { callback_query: { id: "audit-cq", data: `approve:${pendingApprovalId}` } });

    response = await post(8831, "/v1/operators/register", { agent_id: "alpha" }, { "X-Agent-Secret": rotatedSecret });
    const bindForAudit = await response.json();
    await post(8831, "/telegram/webhook", {
      message: { text: `/bind ${bindForAudit.bind_code}`, chat: { id: 999 } },
    });

    response = await post(8831, "/v1/tokens", { subject: "restart-agent", scopes: ["read"] });
    revokedToken = (await response.json()).token;
    await post(8831, "/v1/tokens/revoke", { token: revokedToken });
    await post(8831, "/v1/guard/check", { agent_id: "restart-spend", amount: 30 });
    response = await post(8831, "/v1/guard/check", { agent_id: "restart-pending", amount: 150 });
    pendingApprovalId = (await response.json()).approval_id;
    await delay(300);
  } finally {
    await stop(server);
  }

  server = boot(env, 8831);
  await waitReady(8831, true);
  try {
    let response = await post(8831, "/v1/guard/check", { agent_id: "alpha", amount: 1 });
    ok("strict flag survives restart and rejects missing secret", response.status === 403);
    response = await post(8831, "/v1/guard/check", { agent_id: "alpha", amount: 1 }, { "X-Agent-Secret": rotatedSecret });
    ok("strict claimed guard accepts current secret", response.status === 200);
    response = await post(8831, "/v1/guard/check", { agent_id: " alpha ", amount: 1 });
    ok("strict identity cannot be bypassed with surrounding whitespace", response.status === 403);
    response = await post(8831, "/v1/guard/check", { agent_id: "unclaimed-neighbor", amount: 1 });
    ok("strict mode does not affect another agent", response.status === 200);

    const paidGuardChallenge = await challenge(8831, "/paid/v1/guard/check");
    const beforeStrictPaid = facilitator.hits.settle;
    response = await post(8831, "/paid/v1/guard/check", { agent_id: "alpha", amount: 1 }, paymentHeader(paidGuardChallenge.envelope.accepts[0]));
    await delay(100);
    ok("paid rail does not bypass strict", response.status === 403 && facilitator.hits.settle === beforeStrictPaid);

    response = await post(8831, "/v1/tokens/verify", { token: revokedToken });
    ok("restart gate: revoked token remains revoked", response.status === 403);
    response = await post(8831, "/v1/guard/check", { agent_id: "restart-spend", amount: 1 });
    const spendRestart = await response.json();
    ok("restart gate: today's spend survives", spendRestart.spent_today_after === 31, `spent=${spendRestart.spent_today_after}`);
    response = await fetch(`http://127.0.0.1:8831/v1/approvals/${pendingApprovalId}`);
    const pendingRestart = await response.json();
    ok("restart gate: pending approval survives", response.status === 200 && pendingRestart.status === "pending");
    response = await post(8831, "/v1/operators/register", { agent_id: "alpha" }, { "X-Agent-Secret": rotatedSecret });
    ok("rotated secret survives restart", response.status === 200);
    await delay(300);
  } finally {
    await stop(server);
  }

  const auditDb = JSON.parse(fs.readFileSync(dbFile, "utf8"));
  const auditTypes = new Set(auditDb.events.map((event) => event.type));
  for (const type of [
    "agent_claimed", "binding_changed", "approval_created", "approval_resolved",
    "verdict_issued", "verdict_consumed", "verdict_expired", "token_revoked",
    "claim_payer_mismatch",
  ]) ok(`audit records ${type}`, auditTypes.has(type));
  ok("strict flips use binding_changed with explicit payload",
    auditDb.events.some((event) => event.type === "binding_changed" &&
      event.payload?.change === "strict_mode" && event.payload?.strict_mode === true));

  // The API host's primary CDP/Base rail must carry the same claim contract.
  const cdpPayer = "0x4444444444444444444444444444444444444444";
  const cdpHits = { verify: 0, settle: 0 };
  const cdpFacilitator = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/supported")) return res.end(JSON.stringify({ kinds: [
      { x402Version: 2, scheme: "exact", network: "eip155:8453" },
    ] }));
    if (req.url.endsWith("/verify")) {
      cdpHits.verify++;
      return res.end(JSON.stringify({ isValid: true, payer: cdpPayer }));
    }
    if (req.url.endsWith("/settle")) {
      cdpHits.settle++;
      return res.end(JSON.stringify({
        success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:8453", payer: cdpPayer,
      }));
    }
    res.statusCode = 404;
    res.end("{}");
  }).listen(9922);
  const keys = crypto.generateKeyPairSync("ed25519");
  const seed = keys.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const cdpDb = path.join(temp, "cdp.json");
  const cdpEnv = {
    PAYMENT_MODE: "off",
    API_HOST: "api.test",
    PERSISTENCE: "on",
    CLAW_TEST_DB_FILE: cdpDb,
    CDP_API_KEY_ID: "test-key-id",
    CDP_API_KEY_SECRET: Buffer.concat([seed, publicKey]).toString("base64"),
    CDP_PAY_TO: "0x0361af173cae66337f3f05abdbb2b68e5c88ccfd",
    CDP_FACILITATOR_URL: "http://127.0.0.1:9922",
  };

  // Discovery defaults on for mainnet. Assert that contract before testing
  // the permanent staging override below.
  server = boot(cdpEnv, 8838);
  await waitCdpReady(8838);
  try {
    let response = await hostRequest(8838, "/paid/v1/guard/check", { agent_id: "discovery-default", amount: 1 });
    const required = response.headers["payment-required"];
    const envelope = required ? JSON.parse(Buffer.from(required, "base64").toString("utf8")) : null;
    const health = await waitReady(8838, true);
    ok("DISCOVERY defaults on and declares Bazaar metadata",
      health.features?.cdp_discovery_enabled === true && Boolean(envelope?.extensions?.bazaar));
  } finally { await stop(server); }

  server = boot({ ...cdpEnv, DISCOVERY: "off" }, 8836);
  await waitCdpReady(8836);
  try {
    const health = await waitReady(8836, true);
    let response = await hostRequest(8836, "/paid/v1/guard/check", { agent_id: "staging-no-discovery", amount: 1 });
    let required = response.headers["payment-required"];
    let envelope = required ? JSON.parse(Buffer.from(required, "base64").toString("utf8")) : null;
    const accepts = envelope?.accepts?.[0];
    ok("DISCOVERY=off keeps a valid CDP 402 with no discovery declaration",
      health.features?.cdp_discovery_enabled === false && response.status === 402 &&
      envelope?.x402Version === 2 && accepts?.scheme === "exact" &&
      accepts?.network === "eip155:8453" &&
      (!envelope.extensions || Object.keys(envelope.extensions).length === 0));

    response = await hostRequest(8836, "/paid/v1/agents/claim", undefined, {}, "GET");
    required = response.headers["payment-required"];
    envelope = required ? JSON.parse(Buffer.from(required, "base64").toString("utf8")) : null;
    ok("CDP GET claim discovery probe without payment -> 402",
      response.status === 402 && envelope?.accepts?.[0]?.network === "eip155:8453");
    const cdpSettleBeforePaidGet = cdpHits.settle;
    response = await hostRequest(8836, "/paid/v1/agents/claim", undefined,
      paymentHeader(envelope.accepts[0]), "GET");
    const invalidCdpPaidGet = response.json();
    await delay(100);
    const cdpHealthAfterPaidGet = await waitReady(8836, true);
    ok("paid CDP GET claim rejects missing agent_id before settlement",
      response.status === 400 && invalidCdpPaidGet.error === "missing_field" &&
      cdpHits.settle === cdpSettleBeforePaidGet && cdpHealthAfterPaidGet.memory?.claimed_agents === 0,
      `status=${response.status} settle=${cdpHits.settle} claimed=${cdpHealthAfterPaidGet.memory?.claimed_agents}`);

    response = await hostRequest(8836, "/paid/v1/agents/claim", { agent_id: "cdp-claim" });
    required = response.headers["payment-required"];
    envelope = required ? JSON.parse(Buffer.from(required, "base64").toString("utf8")) : null;
    ok("CDP claim route challenges on Base", response.status === 402 && envelope?.accepts?.[0]?.network === "eip155:8453",
      `status=${response.status} body=${response.text}`);
    if (!envelope) throw new Error("CDP claim challenge missing PAYMENT-REQUIRED");
    response = await hostRequest(8836, "/paid/v1/agents/claim", { agent_id: "cdp-claim" }, paymentHeader(envelope.accepts[0]));
    const cdpClaim = response.json();
    ok("CDP primary rail commits claimed_by from settlement", response.status === 201 && cdpClaim.claimed_by === cdpPayer);
  } finally {
    await stop(server);
    cdpFacilitator.close();
  }

  // Pending execution bindings hydrate across restart. A verdict that expires
  // during downtime is restored first, then refunded by the boot sweep.
  const verdictRestartDb = path.join(temp, "verdict-restart.json");
  const verdictRestartEnv = {
    ...dbEnv(verdictRestartDb, 9921),
    PAYMENT_MODE: "off",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    VERDICT_TTL_S: "10",
  };
  let restartVerdictId;
  server = boot(verdictRestartEnv, 8837);
  await waitReady(8837, true);
  try {
    const response = await post(8837, "/v1/guard/check", { agent_id: "restart-verdict", amount: 30, bind: true });
    restartVerdictId = (await response.json()).verdict_id;
    ok("restart gate prepares a pending execution verdict", response.status === 200 && Boolean(restartVerdictId));
    await delay(100);
  } finally { await stop(server); }

  server = boot(verdictRestartEnv, 8837);
  await waitReady(8837, true);
  try {
    const response = await post(8837, `/v1/verdicts/${restartVerdictId}/consume`, {});
    ok("restart gate: pending verdict survives restart and remains consumable", response.status === 200);
  } finally { await stop(server); }

  let downtimeVerdictId;
  server = boot(verdictRestartEnv, 8837);
  await waitReady(8837, true);
  try {
    const response = await post(8837, "/v1/guard/check", { agent_id: "downtime-refund", amount: 40, bind: true });
    downtimeVerdictId = (await response.json()).verdict_id;
    await delay(100);
  } finally { await stop(server); }
  const verdictRestartRows = JSON.parse(fs.readFileSync(verdictRestartDb, "utf8"));
  verdictRestartRows.verdicts[downtimeVerdictId].issued_at = new Date(Date.now() - 20000).toISOString();
  fs.writeFileSync(verdictRestartDb, JSON.stringify(verdictRestartRows));

  server = boot(verdictRestartEnv, 8837);
  await waitReady(8837, true);
  try {
    let response = await post(8837, `/v1/verdicts/${downtimeVerdictId}/consume`, {});
    ok("verdict expired during downtime is unavailable after first boot sweep", response.status === 404);
    response = await post(8837, "/v1/guard/check", { agent_id: "downtime-refund", amount: 1 });
    const afterDowntimeRefund = await response.json();
    ok("first boot sweep refunds a same-day verdict that expired during downtime",
      afterDowntimeRefund.spent_today_after === 1, `spent=${afterDowntimeRefund.spent_today_after}`);
  } finally { await stop(server); }

  // Hard DB endpoints fail closed while ordinary routes retain v0.8 behavior.
  const offDb = path.join(temp, "off.json");
  server = boot({ ...env, PAYMENT_MODE: "off", PERSISTENCE: "off", CLAW_TEST_DB_FILE: offDb }, 8832);
  await waitReady(8832);
  try {
    let response = await post(8832, "/paid/v1/agents/claim", { agent_id: "off" });
    ok("PERSISTENCE=off claim fails closed", response.status === 503 && (await response.json()).error === "feature_disabled");
    response = await post(8832, "/v1/agents/rotate", { agent_id: "off" });
    ok("PERSISTENCE=off rotate fails closed", response.status === 503);
    response = await post(8832, "/v1/agents/strict", { agent_id: "off", strict: true });
    ok("PERSISTENCE=off strict toggle fails closed", response.status === 503);
    response = await post(8832, "/v1/guard/check", { agent_id: "off", amount: 1 });
    ok("PERSISTENCE=off leaves ordinary guard available", response.status === 200);
  } finally { await stop(server); }

  const deadDb = path.join(temp, "dead.json");
  server = boot({ ...env, CLAW_TEST_DB_FILE: deadDb, CLAW_TEST_DB_FAIL: "1" }, 8833);
  await waitReady(8833);
  try {
    let response = await post(8833, "/paid/v1/agents/claim", { agent_id: "dead" });
    ok("dead DB claim fails closed", response.status === 503);
    response = await post(8833, "/v1/agents/rotate", { agent_id: "dead" });
    ok("dead DB rotate fails closed", response.status === 503);
    response = await post(8833, "/v1/agents/strict", { agent_id: "dead", strict: true });
    ok("dead DB strict toggle fails closed", response.status === 503);
    response = await post(8833, "/v1/tokens", { subject: "still-live", scopes: ["read"] });
    ok("dead DB leaves non-security endpoints available", response.status === 200);
  } finally { await stop(server); }

  // FIFO retention: deliberately tiny limit, then create more audit events.
  const fifoDb = path.join(temp, "fifo.json");
  server = boot(dbEnv(fifoDb, 9921, { EVENT_LIMIT: "3", VERDICT_TTL_S: "30" }), 8834);
  await waitReady(8834, true);
  try {
    for (let i = 0; i < 8; i++) {
      let response = await post(8834, "/v1/tokens", { subject: `fifo-${i}`, scopes: ["read"] });
      const token = (await response.json()).token;
      await post(8834, "/v1/tokens/revoke", { token });
    }
    await delay(500);
  } finally { await stop(server); }
  const fifo = JSON.parse(fs.readFileSync(fifoDb, "utf8"));
  ok("audit FIFO pruning respects configured cap", fifo.events.length === 3, `events=${fifo.events.length}`);
  ok("audit FIFO pruning keeps newest events", fifo.events.every((event) => event.type === "token_revoked"));

  // NANDA free contract: five original endpoints remain free for an unclaimed,
  // non-strict caller and never return identity/payment errors.
  const freeDb = path.join(temp, "free.json");
  server = boot({ ...dbEnv(freeDb, 9921), PAYMENT_MODE: "off" }, 8835);
  await waitReady(8835, true);
  try {
    let response = await post(8835, "/v1/tokens", { subject: "nanda", scopes: ["read"] });
    const rootBody = await response.json();
    const root = rootBody.token;
    const delegateResponse = await post(8835, "/v1/tokens/delegate", {
      parent_token: root, audience: "child", scopes: ["read"],
    });
    const delegateBody = await delegateResponse.json();
    const verifyResponse = await post(8835, "/v1/tokens/verify", { token: root });
    const verifyBody = await verifyResponse.json();
    const guardResponse = await post(8835, "/v1/guard/check", { agent_id: "nanda-free", amount: 1 });
    const guardBody = await guardResponse.json();
    const revokeResponse = await post(8835, "/v1/tokens/revoke", { token: root });
    const revokeBody = await revokeResponse.json();
    const results = [response, delegateResponse, verifyResponse, guardResponse, revokeResponse];
    ok("NANDA five free endpoints never return 402/403 for unclaimed non-strict", results.every((item) => item.status !== 402 && item.status !== 403));
    ok("NANDA five free response structures remain unchanged",
      JSON.stringify(Object.keys(rootBody)) === JSON.stringify(["token"]) &&
      JSON.stringify(Object.keys(delegateBody)) === JSON.stringify(["token"]) &&
      JSON.stringify(Object.keys(verifyBody).sort()) === JSON.stringify(["context", "valid"]) &&
      JSON.stringify(Object.keys(revokeBody).sort()) === JSON.stringify(["cascades", "revoked_tid"]) &&
      JSON.stringify(Object.keys(guardBody).sort()) === JSON.stringify([
        "agent_id", "evaluated_at", "policy_used", "reasons", "spent_today_after", "triggered_rules", "verdict",
      ].sort()));
  } finally { await stop(server); facilitator.server.close(); }

  console.log(fails === 0 ? "\nALL v0.8.1 TESTS PASSED" : `\n${fails} v0.8.1 FAILURE(S)`);
  process.exit(fails ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
