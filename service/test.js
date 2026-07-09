// SPDX-License-Identifier: Apache-2.0
// Self-contained smoke test: spawns server.js, runs every endpoint through
// the happy path and all three attacks, prints PASS/FAIL, exits.
//   node test.js

"use strict";

const { spawn } = require("node:child_process");

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

const post = async (path, body) => {
  const res = await fetch(BASE + path, { method: "POST", body: JSON.stringify(body) });
  return res.json();
};

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`);
  if (!cond) failures += 1;
};

async function main() {
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 600));

  try {
    // --- tokens -----------------------------------------------------------
    const root = (await post("/v1/tokens", { subject: "coordinator", scopes: ["read", "write", "pay"] })).token;
    check("issue root token", typeof root === "string" && root.length > 0);

    const child1 = (
      await post("/v1/tokens/delegate", {
        parent_token: root,
        audience: "worker-1",
        scopes: ["read", "pay"],
        ttl_seconds: 600,
      })
    ).token;
    check("delegate attenuated child", typeof child1 === "string");

    const esc = await post("/v1/tokens/delegate", {
      parent_token: child1,
      audience: "worker-2",
      scopes: ["admin"],
    });
    check("attack 1: scope escalation denied", esc.error === "scope_escalation", esc.detail);

    const confused = await post("/v1/tokens/verify", { token: child1, presenter: "attacker" });
    check("attack 2: audience confusion denied", confused.error === "audience_mismatch", confused.detail);

    const ok = await post("/v1/tokens/verify", { token: child1, presenter: "worker-1" });
    check(
      "legit verify returns context",
      ok.valid === true && ok.context.subject === "worker-1" && ok.context.depth === 2
    );

    const rev = await post("/v1/tokens/revoke", { token: root });
    const dead = await post("/v1/tokens/verify", { token: child1 });
    check(
      "attack 3: cascading revocation kills child",
      rev.cascades === true && dead.error === "revoked_ancestor",
      dead.detail
    );

    const forged = await post("/v1/tokens/verify", { token: Buffer.from('{"chain":[{"aud":"x","scopes":["admin"],"iat":0,"exp":9e9,"parent":null,"tid":"ff"}],"sig":"00"}').toString("base64url") });
    check("forged signature rejected", forged.error === "invalid_signature");

    // --- guard/check ------------------------------------------------------
    const allow = await post("/v1/guard/check", { agent_id: "bot-1", amount: 50 });
    check("guard: small tx allowed", allow.verdict === "allow");

    const review = await post("/v1/guard/check", { agent_id: "bot-1", amount: 150 });
    check("guard: above approval threshold -> review", review.verdict === "review");

    const deny = await post("/v1/guard/check", { agent_id: "bot-1", amount: 999 });
    check("guard: above per-tx limit -> deny", deny.verdict === "deny");

    let verdicts = [];
    for (let i = 0; i < 15; i += 1) {
      const r = await post("/v1/guard/check", { agent_id: "bot-2", amount: 15, policy: "conservative" });
      verdicts.push(r.verdict);
    }
    const allows = verdicts.filter((v) => v === "allow").length;
    const denies = verdicts.filter((v) => v === "deny").length;
    check(
      "guard: daily limit accumulates then denies",
      allows === 13 && denies === 2 && verdicts[12] === "allow" && verdicts[13] === "deny",
      `allows=${allows} denies=${denies}`
    );

    const inline = await post("/v1/guard/check", {
      agent_id: "bot-3",
      amount: 30,
      destination: "0xbad",
      policy: {
        name: "custom",
        rules: [{ type: "allowlist", field: "destination", values: ["0xgood"] }],
      },
    });
    check("guard: inline policy allowlist denies", inline.verdict === "deny", inline.reasons.join("; "));
  } finally {
    child.kill();
  }

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
