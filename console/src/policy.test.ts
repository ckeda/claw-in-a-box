import { describe, expect, it } from "vitest";
import { DEFAULT_INLINE_POLICY, parsePolicyJson, validatePolicyObject } from "./policy";

describe("inline policy validation", () => {
  it("accepts the documented four primitives", () => {
    const parsed = parsePolicyJson(DEFAULT_INLINE_POLICY);
    expect(parsed.errors).toEqual([]);
    expect(parsed.policy?.rules).toHaveLength(3);
  });

  it("rejects unsupported rule types", () => {
    expect(validatePolicyObject({ rules: [{ type: "execute_everything" }] })[0]).toMatch(/supported primitive/);
  });

  it("rejects invalid UTC windows", () => {
    const errors = validatePolicyObject({ rules: [{ type: "time_window", allow_utc_hours: [[18, 9]] }] });
    expect(errors.join(" ")).toMatch(/increasing/);
  });

  it("reports invalid JSON without throwing", () => {
    expect(parsePolicyJson("{nope").errors[0]).toMatch(/Invalid JSON/);
  });
});
