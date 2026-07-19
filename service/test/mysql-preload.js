// Test-only mysql2/promise preload. It provides the small SQL surface used by
// storage.js and persists rows to a JSON file so restart tests exercise the
// real hydrate path without requiring a developer MySQL daemon.
"use strict";

const fs = require("node:fs");
const Module = require("node:module");

const file = process.env.CLAW_TEST_DB_FILE;
if (!file) throw new Error("CLAW_TEST_DB_FILE is required by mysql-preload.js");

const empty = () => ({
  revoked_tokens: {},
  daily_spend: {},
  approvals: {},
  operator_bindings: {},
  agents: {},
  verdicts: {},
  events: [],
  next_event_id: 1,
  spend_ledger: [],
  next_spend_id: 1,
  recovery_nonces: {},
});

function load() {
  try { return { ...empty(), ...JSON.parse(fs.readFileSync(file, "utf8")) }; }
  catch { return empty(); }
}

let data = load();
const reservedAgents = new Set();
const clone = (value) => JSON.parse(JSON.stringify(value));
const save = () => fs.writeFileSync(file, JSON.stringify(data));
const normalized = (sql) => String(sql).replace(/\s+/g, " ").trim().toLowerCase();

function duplicate() {
  const error = new Error("Duplicate entry");
  error.code = "ER_DUP_ENTRY";
  error.errno = 1062;
  return error;
}

function execute(target, sql, params = []) {
  const q = normalized(sql);
  if (q.startsWith("create table")) return [{ affectedRows: 0 }, []];
  if (q.startsWith("insert ignore into revoked_tokens")) {
    target.revoked_tokens[params[0]] = { tid: params[0] };
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("insert into daily_spend")) {
    target.daily_spend[params[0]] = { agent_id: params[0], day: params[1], spent: Number(params[2]) };
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("insert into spend_ledger")) {
    target.spend_ledger.push({
      id: target.next_spend_id++,
      agent_id: params[0],
      day: params[1],
      delta: Number(params[2]),
      spent_after: Number(params[3]),
      reason: params[4],
      ref_id: params[5] ?? null,
      created_at: new Date().toISOString(),
    });
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("delete from spend_ledger")) {
    const cutoffMs = Number(params[0]) * 1000;
    target.spend_ledger = target.spend_ledger.filter(
      (row) => new Date(row.created_at).getTime() >= cutoffMs
    );
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("delete from daily_spend")) {
    for (const [id, row] of Object.entries(target.daily_spend)) if (row.day !== params[0]) delete target.daily_spend[id];
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("insert into approvals")) {
    target.approvals[params[0]] = { id: params[0], status: params[1], payload: JSON.parse(params[2]) };
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("update approvals")) {
    const row = target.approvals[params[2]];
    if (row) Object.assign(row, { status: params[0], payload: JSON.parse(params[1]) });
    return [{ affectedRows: row ? 1 : 0 }, []];
  }
  if (q.startsWith("delete from approvals")) {
    delete target.approvals[params[0]];
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("insert into operator_bindings")) {
    target.operator_bindings[params[0]] = { agent_id: params[0], chat_id: String(params[1]) };
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("insert into agents")) {
    if (target.agents[params[0]]) throw duplicate();
    target.agents[params[0]] = {
      agent_id: params[0], secret_hash: params[1], claimed_at: params[2],
      claimed_by: null, strict_mode: 0,
    };
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("update agents set claimed_by")) {
    const row = target.agents[params[1]];
    if (row) row.claimed_by = params[0];
    return [{ affectedRows: row ? 1 : 0 }, []];
  }
  if (q.startsWith("update agents set secret_hash")) {
    const row = target.agents[params[1]];
    if (!row || (params.length > 2 && row.secret_hash !== params[2])) return [{ affectedRows: 0 }, []];
    row.secret_hash = params[0];
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("update agents set strict_mode")) {
    const row = target.agents[params[1]];
    if (!row || (params.length > 2 && row.secret_hash !== params[2])) return [{ affectedRows: 0 }, []];
    row.strict_mode = params[0] ? 1 : 0;
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("insert into verdicts")) {
    target.verdicts[params[0]] = {
      id: params[0], agent_id: params[1], amount: Number(params[2]), day: params[3],
      status: params[4], issued_at: params[5], consumed_at: null,
    };
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("update verdicts")) {
    const row = target.verdicts[params[2]];
    if (row) Object.assign(row, { status: params[0], consumed_at: params[1] });
    return [{ affectedRows: row ? 1 : 0 }, []];
  }
  if (q.startsWith("insert into events")) {
    const literalClaim = q.includes("values ('agent_claimed'");
    const type = literalClaim ? "agent_claimed" : params[0];
    const offset = literalClaim ? -1 : 0;
    target.events.push({
      id: target.next_event_id++,
      ts: new Date().toISOString(),
      type,
      agent_id: params[1 + offset] ?? null,
      ref_id: params[2 + offset] ?? null,
      payload: JSON.parse(params[3 + offset] || "{}"),
    });
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("insert into agent_recovery_nonces")) {
    if (target.recovery_nonces[params[0]]) throw duplicate();
    target.recovery_nonces[params[0]] = {
      nonce_hash: params[0],
      agent_id: params[1],
      domain: params[2],
      issued_at_ms: Number(params[3]),
      expires_at_ms: Number(params[4]),
      used_at: null,
    };
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("update agent_recovery_nonces set used_at")) {
    const row = target.recovery_nonces[params[0]];
    if (!row || row.used_at) return [{ affectedRows: 0 }, []];
    row.used_at = new Date().toISOString();
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("delete from agent_recovery_nonces")) {
    for (const [hash, row] of Object.entries(target.recovery_nonces)) {
      if (Number(row.expires_at_ms) < Number(params[0])) delete target.recovery_nonces[hash];
    }
    return [{ affectedRows: 1 }, []];
  }
  if (q.startsWith("delete from events")) {
    const limit = Number(params[0]);
    if (target.events.length > limit) target.events = target.events.slice(-limit);
    return [{ affectedRows: 1 }, []];
  }
  throw new Error(`mysql test double does not implement: ${q}`);
}

function query(target, sql, params = []) {
  const q = normalized(sql);
  if (q.startsWith("create table")) return [{ affectedRows: 0 }, []];
  if (q === "select tid from revoked_tokens") return [Object.values(target.revoked_tokens), []];
  if (q.startsWith("select agent_id, day, spent from daily_spend")) {
    if (q.includes("where agent_id = ?")) {
      return [Object.values(target.daily_spend).filter(
        (row) => row.agent_id === params[0] && row.day === params[1]
      ), []];
    }
    return [Object.values(target.daily_spend).filter((row) => row.day === params[0]), []];
  }
  if (q === "select agent_id, chat_id from operator_bindings") return [Object.values(target.operator_bindings), []];
  if (q.startsWith("select id, payload from approvals")) {
    return [Object.values(target.approvals).filter((row) => row.status === "pending"), []];
  }
  if (q.startsWith("select id, status, payload from approvals")) {
    const status = q.includes("where status = ?") ? params[0] : null;
    const limitMatch = q.match(/limit (\d+)$/);
    const limit = limitMatch ? Number(limitMatch[1]) : 25;
    return [Object.values(target.approvals)
      .filter((row) => !status || row.status === status)
      .sort((a, b) => String(b.payload.created_at || "").localeCompare(String(a.payload.created_at || "")))
      .slice(0, limit), []];
  }
  if (q.startsWith("select id, agent_id, amount, day, status, issued_at, consumed_at from verdicts")) {
    return [Object.values(target.verdicts).filter((row) => row.status === "pending"), []];
  }
  if (q.startsWith("select agent_id, secret_hash")) return [Object.values(target.agents), []];
  if (q.startsWith("select id, delta, spent_after")) {
    return [target.spend_ledger
      .filter((row) => row.agent_id === params[0])
      .sort((a, b) => b.id - a.id)
      .slice(0, 50), []];
  }
  if (q.startsWith("select count(*) as claimed")) {
    const rows = Object.values(target.agents);
    return [[{
      claimed: rows.length,
      strict_count: rows.filter((row) => Boolean(Number(row.strict_mode))).length,
    }], []];
  }
  if (q.startsWith("select count(*) as pending from approvals")) {
    return [[{ pending: Object.values(target.approvals).filter((row) => row.status === "pending").length }], []];
  }
  if (q.startsWith("select count(*) as pending from verdicts")) {
    return [[{ pending: Object.values(target.verdicts).filter((row) => row.status === "pending").length }], []];
  }
  if (q.startsWith("select count(*) as active_agents_today")) {
    return [[{
      active_agents_today: Object.values(target.daily_spend).filter((row) => row.day === params[0]).length,
    }], []];
  }
  if (q.startsWith("select count(*) as ledger_changes_24h")) {
    const sinceMs = Number(params[0]) * 1000;
    return [[{
      ledger_changes_24h: target.spend_ledger.filter(
        (row) => new Date(row.created_at).getTime() >= sinceMs
      ).length,
    }], []];
  }
  if (q.startsWith("select coalesce(sum(type = 'approval_resolved'")) {
    const sinceMs = Number(params[0]) * 1000;
    const events = target.events.filter((event) => new Date(event.ts).getTime() >= sinceMs);
    return [[{
      approved_24h: events.filter((event) => event.type === "approval_resolved" && event.payload.status === "approved").length,
      denied_24h: events.filter((event) => event.type === "approval_resolved" && event.payload.status === "denied").length,
      approval_expired_24h: events.filter((event) => event.type === "approval_resolved" && event.payload.status === "expired").length,
      consumed_24h: events.filter((event) => event.type === "verdict_consumed").length,
      verdict_expired_24h: events.filter((event) => event.type === "verdict_expired").length,
    }], []];
  }
  if (q.startsWith("select agent_id, claimed_by from agents where agent_id = ?")) {
    const row = target.agents[params[0]];
    return [row ? [row] : [], []];
  }
  if (q.startsWith("select n.nonce_hash")) {
    const nonce = target.recovery_nonces[params[0]];
    if (!nonce) return [[], []];
    const agent = target.agents[nonce.agent_id];
    return [[{ ...nonce, claimed_by: agent?.claimed_by ?? null }], []];
  }
  if (q.startsWith("select nonce_hash, agent_id, domain, expires_at_ms, used_at")) {
    const nonce = target.recovery_nonces[params[0]];
    return [nonce ? [nonce] : [], []];
  }
  if (q.startsWith("select agent_id, claimed_by from agents where agent_id = ? for update")) {
    const row = target.agents[params[0]];
    return [row ? [row] : [], []];
  }
  return execute(target, sql, params);
}

function createPool() {
  if (process.env.CLAW_TEST_DB_FAIL === "1") {
    return {
      getConnection: async () => { throw new Error("test database unavailable"); },
      query: async () => { throw new Error("test database unavailable"); },
      execute: async () => { throw new Error("test database unavailable"); },
    };
  }
  return {
    async getConnection() {
      let transaction = null;
      let reservedAgent = null;
      return {
        async beginTransaction() { transaction = clone(data); },
        async query(sql, params) { return query(transaction || data, sql, params); },
        async execute(sql, params) {
          if (normalized(sql).startsWith("insert into agents")) {
            const agentId = params[0];
            if (data.agents[agentId] || reservedAgents.has(agentId)) throw duplicate();
            reservedAgents.add(agentId);
            reservedAgent = agentId;
          }
          return execute(transaction || data, sql, params);
        },
        async commit() {
          data = transaction || data;
          transaction = null;
          if (reservedAgent) reservedAgents.delete(reservedAgent);
          reservedAgent = null;
          save();
        },
        async rollback() {
          transaction = null;
          if (reservedAgent) reservedAgents.delete(reservedAgent);
          reservedAgent = null;
        },
        release() {},
      };
    },
    async query(sql, params) { return query(data, sql, params); },
    async execute(sql, params) {
      const result = execute(data, sql, params);
      save();
      return result;
    },
  };
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "mysql2/promise") return { createPool };
  return originalLoad.call(this, request, parent, isMain);
};
