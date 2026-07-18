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
    if (!row || row.secret_hash !== params[2]) return [{ affectedRows: 0 }, []];
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
    return [Object.values(target.daily_spend).filter((row) => row.day === params[0]), []];
  }
  if (q === "select agent_id, chat_id from operator_bindings") return [Object.values(target.operator_bindings), []];
  if (q.startsWith("select id, payload from approvals")) {
    return [Object.values(target.approvals).filter((row) => row.status === "pending"), []];
  }
  if (q.startsWith("select id, agent_id, amount, day, status, issued_at, consumed_at from verdicts")) {
    return [Object.values(target.verdicts).filter((row) => row.status === "pending"), []];
  }
  if (q.startsWith("select agent_id, secret_hash")) return [Object.values(target.agents), []];
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
