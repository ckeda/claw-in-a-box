// SPDX-License-Identifier: Apache-2.0
// storage.js — optional MySQL persistence layer (v0.8.0).
//
// Modes (env PERSISTENCE): "off" (default) | "shadow" | "on"
//   off    — no DB, no mysql2 require. Byte-identical to v0.7 behavior.
//   shadow — memory is the source of truth; every mutation is ALSO written to
//            MySQL, fire-and-forget. DB failures are counted, never thrown.
//   on     — shadow + hydrate at boot: revoked tokens, today's spend ledger,
//            operator bindings and PENDING approvals are restored from MySQL
//            into memory before traffic resumes. Memory remains the runtime
//            source of truth — reads never touch the DB.
//
// Design rule inherited from the x402 layers: an unreachable database must
// never crash or block the process. Connect failures retry every 60s in the
// background; while disconnected all hooks are silent no-ops.

"use strict";

const MODE = String(process.env.PERSISTENCE || "off").toLowerCase();

const state = {
  mode: MODE,
  db_connected: false,
  hydrated: false,
  writes_ok: 0,
  writes_failed: 0,
  last_error: null,
};

let pool = null;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS revoked_tokens (
     tid VARCHAR(64) PRIMARY KEY,
     revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS daily_spend (
     agent_id VARCHAR(191) PRIMARY KEY,
     day CHAR(10) NOT NULL,
     spent DOUBLE NOT NULL,
     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS approvals (
     id VARCHAR(32) PRIMARY KEY,
     status VARCHAR(16) NOT NULL,
     payload JSON NOT NULL,
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
     resolved_at TIMESTAMP NULL
   )`,
  `CREATE TABLE IF NOT EXISTS operator_bindings (
     agent_id VARCHAR(191) PRIMARY KEY,
     chat_id VARCHAR(64) NOT NULL,
     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   )`,
];

// fire-and-forget write; safe in every mode and every connection state
function fire(sql, params) {
  if (!pool || !state.db_connected) return;
  pool
    .execute(sql, params)
    .then(() => { state.writes_ok++; })
    .catch((e) => { state.writes_failed++; state.last_error = e.message; });
}

function init() {
  if (MODE === "off") return Promise.resolve(state);
  let mysql;
  try {
    mysql = require("mysql2/promise");
  } catch {
    state.last_error = "mysql2 not installed";
    console.error("[persistence] mysql2 missing — persistence disabled");
    return Promise.resolve(state);
  }
  pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "",
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL || 4),
    connectTimeout: 8000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
  });

  return new Promise((resolve) => {
    let settled = false;
    async function tryConnect() {
      try {
        const conn = await pool.getConnection();
        try { for (const t of TABLES) await conn.query(t); } finally { conn.release(); }
        state.db_connected = true;
        console.log(`[persistence] MySQL connected, tables ready (mode=${MODE})`);
      } catch (e) {
        state.db_connected = false;
        state.last_error = e.message;
        console.error("[persistence] connect failed, retrying in 60s:", e.message);
        setTimeout(tryConnect, 60000).unref();
      }
      if (!settled) { settled = true; resolve(state); }
    }
    tryConnect();
  });
}

// Boot-time hydration (mode "on" only). targets:
//   { revoked:Set, dailySpend:Map, operatorBindings:Map, restoreApproval(id,row) }
async function hydrate(targets) {
  if (MODE !== "on" || !pool || !state.db_connected) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [rev] = await pool.query("SELECT tid FROM revoked_tokens");
    for (const r of rev) targets.revoked.add(r.tid);
    const [sp] = await pool.query("SELECT agent_id, day, spent FROM daily_spend WHERE day = ?", [today]);
    for (const r of sp) targets.dailySpend.set(r.agent_id, { day: r.day, spent: Number(r.spent) });
    const [ob] = await pool.query("SELECT agent_id, chat_id FROM operator_bindings");
    for (const r of ob) targets.operatorBindings.set(r.agent_id, String(r.chat_id));
    const [ap] = await pool.query("SELECT id, payload FROM approvals WHERE status = 'pending'");
    for (const r of ap) {
      const row = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
      targets.restoreApproval(r.id, row);
    }
    state.hydrated = true;
    console.log(
      `[persistence] hydrated: revoked=${rev.length} spend=${sp.length} ` +
      `bindings=${ob.length} pending_approvals=${ap.length}`
    );
  } catch (e) {
    state.last_error = e.message;
    console.error("[persistence] hydrate failed (memory continues empty):", e.message);
  }
}

const approvalRow = (a) => { const { waiters, ...rest } = a; return rest; };

module.exports = {
  state,
  init,
  hydrate,
  saveRevoked: (tid) => fire("INSERT IGNORE INTO revoked_tokens (tid) VALUES (?)", [tid]),
  saveSpend: (agentId, day, spent) =>
    fire(
      "INSERT INTO daily_spend (agent_id, day, spent) VALUES (?,?,?) " +
      "ON DUPLICATE KEY UPDATE day=VALUES(day), spent=VALUES(spent)",
      [agentId, day, spent]
    ),
  saveApproval: (a) =>
    fire(
      "INSERT INTO approvals (id, status, payload) VALUES (?,?,?) " +
      "ON DUPLICATE KEY UPDATE status=VALUES(status), payload=VALUES(payload)",
      [a.id, a.status, JSON.stringify(approvalRow(a))]
    ),
  updateApproval: (a) =>
    fire("UPDATE approvals SET status=?, payload=?, resolved_at=NOW() WHERE id=?",
      [a.status, JSON.stringify(approvalRow(a)), a.id]),
  deleteApproval: (id) => fire("DELETE FROM approvals WHERE id=?", [id]),
  saveBinding: (agentId, chatId) =>
    fire(
      "INSERT INTO operator_bindings (agent_id, chat_id) VALUES (?,?) " +
      "ON DUPLICATE KEY UPDATE chat_id=VALUES(chat_id)",
      [agentId, chatId]
    ),
  purgeOldSpend: (today) => fire("DELETE FROM daily_spend WHERE day <> ?", [today]),
};
