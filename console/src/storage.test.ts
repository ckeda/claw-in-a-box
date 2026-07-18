import { beforeEach, describe, expect, it } from "vitest";
import { HISTORY_KEY, MAX_HISTORY, MAX_TOKENS, TOKENS_KEY, loadHistory, loadTokenRecords, saveHistory, saveTokenRecords } from "./storage";
import type { TokenRecord, VerdictHistoryItem } from "./types";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("bounded local Console state", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
  });

  it("caps verdict history", () => {
    const items = Array.from({ length: MAX_HISTORY + 5 }, (_, index) => ({
      id: String(index),
      createdAt: "2026-07-18T00:00:00Z",
      request: { agent_id: "console-test", amount: index },
      response: { verdict: "allow", triggered_rules: [], reasons: [], policy_used: "standard", agent_id: "console-test", spent_today_after: index, evaluated_at: "2026-07-18T00:00:00Z" },
    } satisfies VerdictHistoryItem));
    expect(saveHistory(items)).toHaveLength(MAX_HISTORY);
    expect(loadHistory()).toHaveLength(MAX_HISTORY);
    expect(localStorage.getItem(HISTORY_KEY)).toBeTruthy();
  });

  it("deduplicates and caps capability tokens", () => {
    const items = Array.from({ length: MAX_TOKENS + 4 }, (_, index) => ({ token: `token-${index}`, createdAt: "now", verification: "unknown" } satisfies TokenRecord));
    items.unshift(items[0]);
    expect(saveTokenRecords(items)).toHaveLength(MAX_TOKENS);
    expect(loadTokenRecords()).toHaveLength(MAX_TOKENS);
    expect(localStorage.getItem(TOKENS_KEY)).toBeTruthy();
  });
});
