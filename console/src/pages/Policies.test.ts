import { describe, expect, it } from "vitest";
import type { PolicyRule } from "../types";
import { policyRuleSlots } from "./Policies";

describe("policy card row slots", () => {
  it("keeps the fixed rule order and reserves an absent allowlist row", () => {
    const rules: PolicyRule[] = [
      { type: "require_approval", when_amount_over: 500 },
      { type: "spend_limit", per_tx: 1000, daily: 5000 },
    ];

    const slots = policyRuleSlots(rules);

    expect(slots.map(({ type }) => type)).toEqual([
      "spend_limit",
      "require_approval",
      "allowlist",
    ]);
    expect(slots[0].rule).toBe(rules[1]);
    expect(slots[1].rule).toBe(rules[0]);
    expect(slots[2].rule).toBeUndefined();
    expect(rules).toHaveLength(2);
  });
});
