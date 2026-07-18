// SPDX-License-Identifier: Apache-2.0
// storage.js — optional MySQL persistence plus the v0.8.1 hard-DB identity
// boundary. Ordinary v0.8 state remains memory-first/fire-and-forget. Agent
// claims and secret rotation are deliberately different: they only succeed in
// PERSISTENCE=on after a live database has been hydrated.

"use strict";

const MODE = String(process.env.PERSISTENCE || "off").toLowerCase();
const EVENT_LIMIT = Number(process.env.EVENT_LIMIT || 100000);

const state = {
  mode: MODE,
  db_connected: false,
  hydrated: false,
  writes_ok: 0,
  writes_failed: 0,
  last_error: null,
};

let pool = null;
let retryTimer = null;
let reconnect = null;
let hydrateTargets = null;

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
  `CREATE TABLE IF NOT EXISTS agents (
     agent_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY,
     secret_hash CHAR(64) NOT NULL,
     claimed_at VARCHAR(32) NOT NULL,
     claimed_by VARCHAR(191) NULL,
     strict_mode BOOLEAN NOT NULL DEFAULT FALSE,
     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS verdicts (
     id VARCHAR(64) PRIMARY KEY,
     agent_id VARCHAR(191) NOT NULL,
     amount DOUBLE NOT NULL,
     day CHAR(10) NOT NULL,
     status VARCHAR(16) NOT NULL,
     issued_at VARCHAR(32) NOT NULL,
     consumed_at VARCHAR(32) NULL,
     INDEX verdict_status_issued (status, issued_at)
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     ts TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     type VARCHAR(64) NOT NULL,
     agent_id VARCHAR(191) NULL,
     ref_id VARCHAR(191) NULL,
     payload JSON NOT NULL,
     INDEX event_type_ts (type, ts),
     INDEX event_agent_ts (agent_id, ts)
   )`,
];

function featureDisabled(detail = "identity persistence is unavailable") {
  const error = new Error(detail);
  error.code = "feature_disabled";
  error.status = 503;
  return error;
}

function alreadyClaimed() {
  const error = new Error("agent_id is already claimed");
  error.code = "already_claimed";
  error.status = 409;
  return error;
}

function isDuplicate(error) {
  return error && (error.code === "ER_DUP_ENTRY" || error.errno === 1062);
}

function recordFailure(error) {
  state.writes_failed++;
  state.last_error = error && error.message ? error.message : String(error);
}

function markDisconnected(error) {
  state.db_connected = false;
  recordFailure(error);
  if (reconnect && !retryTimer) {
    retryTimer = setTimeout(reconnect, 60000);
    retryTimer.unref();
  }
}

function fire(sql, params) {
  if (!pool || !state.db_connected) return;
  pool.execute(sql, params)
    .then(() => { state.writes_ok++; })
    .catch(markDisconnected);
}

function audit(type, agentId = null, refId = null, payload = {}) {
  if (!pool || !state.db_connected) return;
  pool.execute(
    "INSERT INTO events (type, agent_id, ref_id, payload) VALUES (?,?,?,?)",
    [type, agentId, refId, JSON.stringify(payload || {})]
  ).then(() => {
    state.writes_ok++;
    return pool.execute(
      "DELETE FROM events WHERE id <= (" +
      "SELECT cutoff FROM (SELECT id AS cutoff FROM events ORDER BY id DESC LIMIT 1 OFFSET ?) AS old_events)",
      [EVENT_LIMIT]
    );
  }).catch(markDisconnected);
}

function hardReady() {
  return MODE === "on" && Boolean(pool) && state.db_connected && state.hydrated;
}

function requireHardReady() {
  if (!hardReady()) throw featureDisabled();
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
      retryTimer = null;
      try {
        const conn = await pool.getConnection();
        try {
          for (const table of TABLES) await conn.query(table);
        } finally {
          conn.release();
        }
        state.db_connected = true;
        console.log(`[persistence] MySQL connected, tables ready (mode=${MODE})`);
        if (hydrateTargets && !state.hydrated) await hydrate(hydrateTargets);
      } catch (error) {
        state.db_connected = false;
        state.last_error = error.message;
        console.error("[persistence] connect failed, retrying in 60s:", error.message);
        retryTimer = setTimeout(tryConnect, 60000);
        retryTimer.unref();
      }
      if (!settled) {
        settled = true;
        resolve(state);
      }
    }
    reconnect = tryConnect;
    tryConnect();
  });
}

// targets: revoked, dailySpend, operatorBindings, restoreApproval,
// restoreClaimedAgent. Hydration is all-or-nothing from the security layer's
// point of view: state.hydrated only flips after the agent rows are loaded.
async function hydrate(targets) {
  hydrateTargets = targets;
  if (MODE !== "on" || !pool || !state.db_connected) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [rev] = await pool.query("SELECT tid FROM revoked_tokens");
    for (const row of rev) targets.revoked.add(row.tid);
    const [spend] = await pool.query(
      "SELECT agent_id, day, spent FROM daily_spend WHERE day = ?", [today]
    );
    for (const row of spend) {
      targets.dailySpend.set(row.agent_id, { day: row.day, spent: Number(row.spent) });
    }
    const [bindings] = await pool.query("SELECT agent_id, chat_id FROM operator_bindings");
    for (const row of bindings) {
      targets.operatorBindings.set(row.agent_id, String(row.chat_id));
    }
    const [pending] = await pool.query(
      "SELECT id, payload FROM approvals WHERE status = 'pending'"
    );
    for (const row of pending) {
      const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      targets.restoreApproval(row.id, payload);
    }
    const [agents] = await pool.query(
      "SELECT agent_id, secret_hash, claimed_at, claimed_by, strict_mode FROM agents"
    );
    for (const row of agents) targets.restoreClaimedAgent(row);
    state.hydrated = true;
    console.log(
      `[persistence] hydrated: revoked=${rev.length} spend=${spend.length} ` +
      `bindings=${bindings.length} pending_approvals=${pending.length} agents=${agents.length}`
    );
  } catch (error) {
    markDisconnected(error);
    console.error("[persistence] hydrate failed (security features remain closed):", error.message);
  }
}

// Reserve an agent id in an open transaction. The row is invisible until the
// payment middleware reports a successful settlement and commitClaim commits.
// A competing INSERT waits on the unique key and then fails before it settles.
async function beginClaim(agentId, secretHash, claimedAt) {
  requireHardReady();
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.execute(
      "INSERT INTO agents (agent_id, secret_hash, claimed_at, claimed_by, strict_mode) VALUES (?,?,?,NULL,FALSE)",
      [agentId, secretHash, claimedAt]
    );
    return { conn, agentId, secretHash, claimedAt, done: false, committed: false };
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch {}
      conn.release();
    }
    if (isDuplicate(error)) throw alreadyClaimed();
    markDisconnected(error);
    throw featureDisabled();
  }
}

async function commitClaim(transaction, payer) {
  if (!transaction || transaction.done) return;
  const { conn, agentId } = transaction;
  try {
    await conn.execute("UPDATE agents SET claimed_by=? WHERE agent_id=?", [payer, agentId]);
    await conn.commit();
    transaction.done = true;
    transaction.committed = true;
    state.writes_ok++;
  } catch (error) {
    try { await conn.rollback(); } catch {}
    transaction.done = true;
    markDisconnected(error);
    throw error;
  } finally {
    conn.release();
  }
}

async function rollbackClaim(transaction) {
  if (!transaction || transaction.done) return;
  transaction.done = true;
  try { await transaction.conn.rollback(); } catch (error) { recordFailure(error); }
  transaction.conn.release();
}

async function rotateAgent(agentId, oldHash, newHash) {
  requireHardReady();
  try {
    const [result] = await pool.execute(
      "UPDATE agents SET secret_hash=? WHERE agent_id=? AND secret_hash=?",
      [newHash, agentId, oldHash]
    );
    if (Number(result.affectedRows) !== 1) {
      const error = new Error("agent secret is invalid or was already rotated");
      error.code = "forbidden";
      error.status = 403;
      throw error;
    }
    state.writes_ok++;
  } catch (error) {
    if (error.status === 403) throw error;
    markDisconnected(error);
    throw featureDisabled();
  }
}

const approvalRow = (approval) => {
  const { waiters, ...rest } = approval;
  return rest;
};

module.exports = {
  state,
  init,
  hydrate,
  hardReady,
  beginClaim,
  commitClaim,
  rollbackClaim,
  rotateAgent,
  audit,
  saveRevoked: (tid) => fire("INSERT IGNORE INTO revoked_tokens (tid) VALUES (?)", [tid]),
  saveSpend: (agentId, day, spent) => fire(
    "INSERT INTO daily_spend (agent_id, day, spent) VALUES (?,?,?) " +
    "ON DUPLICATE KEY UPDATE day=VALUES(day), spent=VALUES(spent)",
    [agentId, day, spent]
  ),
  saveApproval: (approval) => fire(
    "INSERT INTO approvals (id, status, payload) VALUES (?,?,?) " +
    "ON DUPLICATE KEY UPDATE status=VALUES(status), payload=VALUES(payload)",
    [approval.id, approval.status, JSON.stringify(approvalRow(approval))]
  ),
  updateApproval: (approval) => fire(
    "UPDATE approvals SET status=?, payload=?, resolved_at=NOW() WHERE id=?",
    [approval.status, JSON.stringify(approvalRow(approval)), approval.id]
  ),
  deleteApproval: (id) => fire("DELETE FROM approvals WHERE id=?", [id]),
  saveBinding: (agentId, chatId) => fire(
    "INSERT INTO operator_bindings (agent_id, chat_id) VALUES (?,?) " +
    "ON DUPLICATE KEY UPDATE chat_id=VALUES(chat_id)",
    [agentId, chatId]
  ),
  saveVerdict: (verdict) => fire(
    "INSERT INTO verdicts (id, agent_id, amount, day, status, issued_at, consumed_at) VALUES (?,?,?,?,?,?,NULL)",
    [verdict.id, verdict.agent_id, verdict.amount, verdict.day, verdict.status, verdict.issued_at]
  ),
  updateVerdict: (verdict) => fire(
    "UPDATE verdicts SET status=?, consumed_at=? WHERE id=?",
    [verdict.status, verdict.consumed_at || null, verdict.id]
  ),
  purgeOldSpend: (today) => fire("DELETE FROM daily_spend WHERE day <> ?", [today]),
};
