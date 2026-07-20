import type { TokenRecord, VerdictHistoryItem } from "./types";

const HISTORY_KEY = "claw-console.verdict-history.v1";
const TOKENS_KEY = "claw-console.token-records.v1";
const PREFS_KEY = "claw-console.preferences.v1";
const AGENT_CREDENTIAL_KEY = "claw-console.agent-credential.v1";
const OPERATOR_SESSION_KEY = "claw-console.operator-key.v1";
const MAX_HISTORY = 30;
const MAX_TOKENS = 30;
let operatorMemory = "";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be disabled in private browsing; the Console remains usable.
  }
}

export function loadHistory(): VerdictHistoryItem[] {
  const value = readJson<unknown>(HISTORY_KEY, []);
  return Array.isArray(value) ? (value as VerdictHistoryItem[]).slice(0, MAX_HISTORY) : [];
}

export function saveHistory(items: VerdictHistoryItem[]): VerdictHistoryItem[] {
  const bounded = items.slice(0, MAX_HISTORY);
  writeJson(HISTORY_KEY, bounded);
  return bounded;
}

export function loadTokenRecords(): TokenRecord[] {
  const value = readJson<unknown>(TOKENS_KEY, []);
  return Array.isArray(value) ? (value as TokenRecord[]).slice(0, MAX_TOKENS) : [];
}

export function saveTokenRecords(items: TokenRecord[]): TokenRecord[] {
  const unique = [...new Map(items.map((item) => [item.token, item])).values()].slice(0, MAX_TOKENS);
  writeJson(TOKENS_KEY, unique);
  return unique;
}

export function loadPreference(key: string): string | null {
  return readJson<Record<string, string>>(PREFS_KEY, {})[key] || null;
}

export function savePreference(key: string, value: string): void {
  const prefs = readJson<Record<string, string>>(PREFS_KEY, {});
  writeJson(PREFS_KEY, { ...prefs, [key]: value });
}

export function clearConsoleData(): void {
  [HISTORY_KEY, TOKENS_KEY, PREFS_KEY, AGENT_CREDENTIAL_KEY].forEach((key) => localStorage.removeItem(key));
  clearOperatorKey();
}

export interface AgentCredential {
  agentId: string;
  secret: string;
}

export function loadAgentCredential(): AgentCredential | null {
  const value = readJson<Partial<AgentCredential> | null>(AGENT_CREDENTIAL_KEY, null);
  return value?.agentId && value.secret ? { agentId: value.agentId, secret: value.secret } : null;
}

export function saveAgentCredential(value: AgentCredential): void {
  writeJson(AGENT_CREDENTIAL_KEY, value);
}

export function clearAgentCredential(): void {
  localStorage.removeItem(AGENT_CREDENTIAL_KEY);
}

export function loadOperatorKey(): string {
  try {
    return sessionStorage.getItem(OPERATOR_SESSION_KEY) || operatorMemory;
  } catch {
    return operatorMemory;
  }
}

export function saveOperatorKey(value: string): void {
  operatorMemory = value;
  try {
    sessionStorage.setItem(OPERATOR_SESSION_KEY, value);
  } catch {
    // In-memory fallback keeps the operator credential session-only.
  }
}

export function clearOperatorKey(): void {
  operatorMemory = "";
  try {
    sessionStorage.removeItem(OPERATOR_SESSION_KEY);
  } catch {
    // Nothing else persists the operator credential.
  }
}

export function makeConsoleAgentId(purpose = "lab"): string {
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 6);
  return `console-${purpose}-${random}`;
}

export {
  AGENT_CREDENTIAL_KEY,
  HISTORY_KEY,
  MAX_HISTORY,
  MAX_TOKENS,
  OPERATOR_SESSION_KEY,
  TOKENS_KEY,
};
