import type { TokenRecord, VerdictHistoryItem } from "./types";

const HISTORY_KEY = "claw-console.verdict-history.v1";
const TOKENS_KEY = "claw-console.token-records.v1";
const PREFS_KEY = "claw-console.preferences.v1";
const MAX_HISTORY = 30;
const MAX_TOKENS = 30;

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
  [HISTORY_KEY, TOKENS_KEY, PREFS_KEY].forEach((key) => localStorage.removeItem(key));
}

export function makeConsoleAgentId(purpose = "lab"): string {
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 6);
  return `console-${purpose}-${random}`;
}

export { HISTORY_KEY, MAX_HISTORY, MAX_TOKENS, TOKENS_KEY };
