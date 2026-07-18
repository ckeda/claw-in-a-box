// SPDX-License-Identifier: Apache-2.0
// Smoke test: v0.2 paywall + HITL, v0.6 OKX SDK layer, v0.7 CDP layer + status: x402 paywall + Telegram HITL wiring.
// Runs the server in three env modes and checks behavior. node test-v2.js

"use strict";
const { spawn } = require("node:child_process");

let fails = 0;
const ok = (n, c, x) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? " -> " + x : ""}`); if (!c) fails++; };

function boot(env, port) {
  const child = spawn(process.execPath, ["server.js"],
    { env: { ...process.env, PORT: String(port), ...env }, stdio: "ignore" });
  return child;
}
const post = (port, path, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`,
    { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body) });

async function main() {
  // ── Mode A: everything off (must behave exactly like v0.1) ──
  const A = boot({ PAYMENT_MODE: "off" }, 8811);
  await new Promise(r => setTimeout(r, 700));
  try {
    let r = await post(8811, "/v1/guard/check", { agent_id: "a", amount: 150 });
    let d = await r.json();
    ok("free route: review returns directly (no TG configured)",
       d.verdict === "review" && !("approval_id" in d));

    r = await post(8811, "/v1/guard/check", { agent_id: "a", amount: 30 });
    d = await r.json();
    ok("free route: small tx still allowed", d.verdict === "allow");

    r = await post(8811, "/paid/v1/guard/check", { amount: 30 });
    ok("paid route with PAYMENT_MODE=off -> 503", r.status === 503);
  } finally { A.kill(); }

  // ── Mode B: mock x402 paywall ──
  // ── Mode B: SDK x402 against a local mock facilitator (v0.6) ──────────────
  const http = require("node:http");
  let settleHits = 0;
  const fac = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/v6/pay/x402/supported")) {
      return res.end(JSON.stringify({ code: 0, data: { kinds: [
        { x402Version: 2, network: "eip155:196", scheme: "exact" }] } }));
    }
    if (req.url.startsWith("/api/v6/pay/x402/verify")) {
      return res.end(JSON.stringify({ code: 0, data: {
        isValid: true, payer: "0x1111111111111111111111111111111111111111" } }));
    }
    if (req.url.startsWith("/api/v6/pay/x402/settle")) {
      settleHits++;
      return res.end(JSON.stringify({ code: 0, data: {
        success: true, status: "success", transaction: "0x" + "ab".repeat(32),
        network: "eip155:196", amount: "10000",
        payer: "0x1111111111111111111111111111111111111111" } }));
    }
    res.statusCode = 404; res.end("{}");
  }).listen(8899);

  const PAY_TO = "0x0361af173cae66337f3f05abdbb2b68e5c88ccfd";
  const B = boot({
    PAYMENT_MODE: "okx-x402",
    X402_PAY_TO: PAY_TO,
    X402_FACILITATOR_URL: "http://127.0.0.1:8899",
    OKX_API_KEY: "k", OKX_SECRET_KEY: "s", OKX_PASSPHRASE: "p",
  }, 8812);
  await new Promise(r => setTimeout(r, 1200));
  try {
    // 1) GET without payment -> A2MCP-standard 402 challenge (review bots GET)
    let r = await fetch("http://127.0.0.1:8812/paid/v1/guard/check");
    ok("GET paid route without payment -> 402", r.status === 402);
    const prHeader = r.headers.get("payment-required");
    ok("402 carries base64 PAYMENT-REQUIRED header", !!prHeader);
    let env = null;
    try { env = JSON.parse(Buffer.from(prHeader, "base64").toString("utf8")); } catch {}
    ok("PAYMENT-REQUIRED decodes to x402Version=2 envelope",
       env && env.x402Version === 2 && env.resource && Array.isArray(env.accepts),
       JSON.stringify(env)?.slice(0, 120));
    const a = env?.accepts?.[0] || {};
    ok("accepts[0] matches OKX A2MCP spec",
       a.scheme === "exact" && a.network === "eip155:196" &&
       a.asset === "0x779ded0c9e1022225f8e0630b35a9b54be713736" &&
       a.amount === "10000" && a.payTo === PAY_TO &&
       a.extra && a.extra.name === "USD\u20ae0" && a.extra.version === "1",
       `scheme=${a.scheme} network=${a.network} amount=${a.amount} extra=${JSON.stringify(a.extra)}`);

    // 2) POST without payment -> 402 too
    r = await post(8812, "/paid/v1/guard/check", { amount: 30 });
    ok("POST paid route without payment -> 402", r.status === 402);

    // v0.7.1: the OKX-rail mirror path serves the same A2MCP 402
    r = await fetch("http://127.0.0.1:8812/paid-okx/v1/guard/check");
    ok("GET /paid-okx without payment -> 402", r.status === 402, `status=${r.status}`);
    const pr2 = r.headers.get("payment-required");
    let env2b = null;
    try { env2b = JSON.parse(Buffer.from(pr2, "base64").toString("utf8")); } catch {}
    const a2b = env2b?.accepts?.[0] || {};
    ok("/paid-okx envelope is OKX rail (X Layer / USDT0)",
       a2b.network === "eip155:196" && a2b.amount === "10000" &&
       a2b.asset === "0x779ded0c9e1022225f8e0630b35a9b54be713736",
       `network=${a2b.network}`);

    // 3) paid POST with a payload the mock facilitator accepts -> real verdict
    const paymentPayload = {
      x402Version: 2,
      accepted: env.accepts[0],
      payload: { signature: "0xmock", authorization: {} },
    };
    const sig = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    r = await post(8812, "/paid/v1/guard/check", { agent_id: "p", amount: 30 },
                   { "PAYMENT-SIGNATURE": sig });
    ok("paid route with verified payment -> 200", r.status === 200, `status=${r.status}`);
    const d = await r.json().catch(() => ({}));
    ok("paid verdict is a real guard decision", d.verdict === "allow",
       `verdict=${d.verdict}`);
    ok("PAYMENT-RESPONSE header present",
       !!(r.headers.get("payment-response") || r.headers.get("x-payment-response")));
    await new Promise(r => setTimeout(r, 300));
    ok("facilitator settle was called", settleHits >= 1, `settleHits=${settleHits}`);
  } finally { B.kill(); fac.close(); }

  // ── Mode C: TG env set but unreachable (must fail-open to review, not crash) ──
  const C = boot({ TELEGRAM_BOT_TOKEN: "0:fake", TELEGRAM_CHAT_ID: "1", APPROVAL_TIMEOUT_S: "2" }, 8813);
  await new Promise(r => setTimeout(r, 700));
  try {
    // review with TG "configured": should mint an approval_id and a poll url,
    // even though the Telegram API call itself will fail silently
    let r = await post(8813, "/v1/guard/check", { agent_id: "h", amount: 150 });
    let d = await r.json();
    ok("HITL: review mints approval_id + poll url",
       d.verdict === "review" && typeof d.approval_id === "string" && d.poll?.startsWith("/v1/approvals/"),
       `id=${d.approval_id}`);

    // the approval is queryable
    if (d.approval_id) {
      const rr = await fetch(`http://127.0.0.1:8813/v1/approvals/${d.approval_id}`);
      const dd = await rr.json();
      ok("HITL: approval is pending and queryable", dd.status === "pending");
    }

    // simulate a webhook Approve press
    if (d.approval_id) {
      await post(8813, "/telegram/webhook",
        { callback_query: { id: "cq1", data: `approve:${d.approval_id}` } });
      await new Promise(r => setTimeout(r, 150));
      const rr = await fetch(`http://127.0.0.1:8813/v1/approvals/${d.approval_id}`);
      const dd = await rr.json();
      ok("HITL: webhook Approve flips status to approved",
         dd.status === "approved" && dd.final_verdict === "allow");
    }

    // wait=true long-poll that times out -> denied by default
    const r2 = await post(8813, "/v1/guard/check", { agent_id: "h2", amount: 150, wait: true });
    const d2 = await r2.json();
    ok("HITL: wait=true times out -> denied by default",
       d2.verdict === "deny", `verdict=${d2.verdict}`);
  } finally { C.kill(); }


  // ── Mode D (v0.7): CDP layer on the api host, OKX/off path untouched ──────
  const crypto = require("node:crypto");
  const kp = crypto.generateKeyPairSync("ed25519");
  const seed = kp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const CDP_SECRET = Buffer.concat([seed, pub]).toString("base64");


  // node:http-based request helper: undici's fetch does not let us override
  // the Host header, and host dispatch is exactly what Mode D tests.
  const hreq = (port, method, path, { host, headers = {}, body = null } = {}) =>
    new Promise((resolve, reject) => {
      const r = http.request(
        { host: "127.0.0.1", port, method, path,
          headers: { ...(body ? { "content-type": "application/json" } : {}),
                     ...(host ? { host } : {}), ...headers } },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => resolve({
            status: res.statusCode,
            headers: res.headers,
            text: buf,
            json: () => { try { return JSON.parse(buf); } catch { return {}; } },
          }));
        });
      r.on("error", reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });

  let cdpVerify = 0, cdpSettle = 0;
  const cdpFac = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/supported")) {
      return res.end(JSON.stringify({ kinds: [
        { x402Version: 2, scheme: "exact", network: "eip155:8453" }] }));
    }
    if (req.url.endsWith("/verify")) {
      cdpVerify++;
      return res.end(JSON.stringify({ isValid: true,
        payer: "0x2222222222222222222222222222222222222222" }));
    }
    if (req.url.endsWith("/settle")) {
      cdpSettle++;
      return res.end(JSON.stringify({ success: true,
        transaction: "0x" + "cd".repeat(32), network: "eip155:8453",
        payer: "0x2222222222222222222222222222222222222222" }));
    }
    res.statusCode = 404; res.end("{}");
  }).listen(9910);

  const D = boot({
    PAYMENT_MODE: "off",           // non-api hosts must behave exactly like v0.6 "off"
    API_HOST: "api.test",
    CDP_API_KEY_ID: "test-key-id",
    CDP_API_KEY_SECRET: CDP_SECRET,
    CDP_PAY_TO: PAY_TO,
    CDP_FACILITATOR_URL: "http://127.0.0.1:9910",
  }, 8814);
  await new Promise(r => setTimeout(r, 1200));
  try {
    // healthz reports the new layer
    let r = await fetch("http://127.0.0.1:8814/healthz");
    let d = await r.json();
    ok("healthz: version 0.8.0", d.version === "0.8.0", `version=${d.version}`);
    ok("healthz: cdp_x402_enabled", d.features?.cdp_x402_enabled === true);

    // api host: paid route challenges through CDP (Base / USDC)
    let hr = await hreq(8814, "GET", "/paid/v1/guard/check", { host: "api.test" });
    ok("api host: GET paid route -> 402", hr.status === 402, `status=${hr.status}`);
    const pr = hr.headers["payment-required"];
    ok("api host: 402 carries PAYMENT-REQUIRED header", !!pr);
    let env2 = null;
    try { env2 = JSON.parse(Buffer.from(pr, "base64").toString("utf8")); } catch {}
    const acc = env2?.accepts?.[0] || {};
    ok("api host: envelope is x402Version=2 + Base network",
       env2?.x402Version === 2 && acc.network === "eip155:8453" &&
       acc.scheme === "exact" && acc.payTo === PAY_TO,
       `network=${acc.network} payTo=${acc.payTo} amount=${acc.amount} asset=${acc.asset}`);

    // NANDA protection: free routes on the api host are NEVER payment-gated
    hr = await hreq(8814, "POST", "/v1/guard/check", { host: "api.test", body: { agent_id: "n", amount: 30 } });
    ok("api host: free /v1/guard/check stays free (no 402)",
       hr.status === 200 && hr.json().verdict === "allow", `status=${hr.status}`);
    hr = await hreq(8814, "GET", "/healthz", { host: "api.test" });
    ok("api host: /healthz stays free", hr.status === 200);
    hr = await hreq(8814, "GET", "/skill.md", { host: "api.test" });
    ok("api host: skill.md advertises api base URL",
       hr.text.includes("https://api.clawinabox.xyz") && !hr.text.includes("{{BASE_URL}}"));
    hr = await hreq(8814, "GET", "/skill.md", {});
    ok("other host: skill.md advertises okx base URL",
       hr.text.includes("- **Base URL**: `https://okx.clawinabox.xyz`"));

    // non-api host keeps the v0.6 path: PAYMENT_MODE=off -> 503 on /paid
    hr = await hreq(8814, "POST", "/paid/v1/guard/check", { body: { amount: 30 } });
    ok("other host: paid route keeps v0.6 behavior (503 when off)", hr.status === 503);

    // full paid flow through the mock CDP facilitator
    const payload2 = {
      x402Version: 2,
      accepted: env2.accepts[0],
      payload: { signature: "0xmock", authorization: {} },
    };
    const sig2 = Buffer.from(JSON.stringify(payload2)).toString("base64");
    hr = await hreq(8814, "POST", "/paid/v1/guard/check",
      { host: "api.test", headers: { "PAYMENT-SIGNATURE": sig2 },
        body: { agent_id: "cdp", amount: 30 } });
    const dd = hr.json();
    ok("api host: paid POST with verified payment -> 200 + verdict",
       hr.status === 200 && dd.verdict === "allow", `status=${hr.status} verdict=${dd.verdict}`);
    await new Promise(r => setTimeout(r, 300));
    ok("api host: CDP facilitator verify+settle called",
       cdpVerify >= 1 && cdpSettle >= 1, `verify=${cdpVerify} settle=${cdpSettle}`);

    // v0.7.1: /paid-okx on the api host takes the OKX branch, never CDP,
    // never free. PAYMENT_MODE=off here -> the OKX stub answers 503.
    hr = await hreq(8814, "GET", "/paid-okx/v1/guard/check", { host: "api.test" });
    ok("api host: /paid-okx routed to OKX branch (503 stub when off, not CDP 402)",
       hr.status === 503, `status=${hr.status}`);
    hr = await hreq(8814, "POST", "/paid-okx/v1/guard/check", { host: "api.test", body: { agent_id: "fr", amount: 30 } });
    ok("api host: /paid-okx POST does not execute unpaid",
       hr.status === 503 && hr.json().verdict === undefined, `status=${hr.status}`);

    // status page (ported from api v0.1.3)
    hr = await hreq(8814, "GET", "/status", {});
    ok("/status serves the human status page", hr.status === 200 && hr.text.includes("Run check"));
  } finally { D.kill(); cdpFac.close(); }


  // ── Mode F (v0.8.0): persistence must NEVER hurt the request path ─────────
  // off: no DB, healthz reports mode=off
  const F1 = boot({ PAYMENT_MODE: "off", PERSISTENCE: "off" }, 8821);
  await new Promise(r => setTimeout(r, 700));
  try {
    let r = await fetch("http://127.0.0.1:8821/healthz");
    let d = await r.json();
    ok("persistence off: healthz mode=off", d.features?.persistence?.mode === "off");
    r = await post(8821, "/v1/guard/check", { agent_id: "p1", amount: 30 });
    ok("persistence off: guard works", (await r.json()).verdict === "allow");
  } finally { F1.kill(); }

  // shadow with a DEAD database: boots, serves, reports db_connected=false
  const F2 = boot({ PAYMENT_MODE: "off", PERSISTENCE: "shadow",
    DB_HOST: "127.0.0.1", DB_PORT: "9959", DB_USER: "x", DB_PASSWORD: "x", DB_NAME: "x" }, 8822);
  await new Promise(r => setTimeout(r, 2500));
  try {
    let r = await post(8822, "/v1/guard/check", { agent_id: "p2", amount: 30 });
    ok("shadow + dead DB: guard still works", (await r.json()).verdict === "allow");
    r = await post(8822, "/v1/tokens", { subject: "p2", scopes: ["read"] });
    const tok = (await r.json()).token;
    r = await post(8822, "/v1/tokens/revoke", { token: tok });
    ok("shadow + dead DB: revoke works", (await r.json()).cascades === true);
    r = await fetch("http://127.0.0.1:8822/healthz");
    const d = await r.json();
    ok("shadow + dead DB: healthz shows db_connected=false",
       d.features?.persistence?.mode === "shadow" && d.features?.persistence?.db_connected === false,
       JSON.stringify(d.features?.persistence));
  } finally { F2.kill(); }

  console.log(fails === 0 ? "\nALL TESTS PASSED" : `\n${fails} FAILURE(S)`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
