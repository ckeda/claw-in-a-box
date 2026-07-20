import type { Policy, PolicyRule } from "./types";

const RULE_TYPES = new Set(["spend_limit", "require_approval", "allowlist", "time_window"]);

function finiteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validatePolicyObject(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["Policy must be a JSON object."];
  const policy = value as Record<string, unknown>;
  if (policy.name != null && (typeof policy.name !== "string" || !policy.name.trim())) {
    errors.push("name must be a non-empty string when provided.");
  }
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    errors.push("rules must be a non-empty array.");
    return errors;
  }

  policy.rules.forEach((raw, index) => {
    const at = `rules[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${at} must be an object.`);
      return;
    }
    const rule = raw as Record<string, unknown>;
    if (typeof rule.type !== "string" || !RULE_TYPES.has(rule.type)) {
      errors.push(`${at}.type is not a supported primitive.`);
      return;
    }
    if (rule.type === "spend_limit") {
      if (rule.per_tx == null && rule.daily == null) errors.push(`${at} needs per_tx and/or daily.`);
      if (rule.per_tx != null && !finiteNonNegative(rule.per_tx)) errors.push(`${at}.per_tx must be ≥ 0.`);
      if (rule.daily != null && !finiteNonNegative(rule.daily)) errors.push(`${at}.daily must be ≥ 0.`);
    }
    if (rule.type === "require_approval" && !finiteNonNegative(rule.when_amount_over)) {
      errors.push(`${at}.when_amount_over must be ≥ 0.`);
    }
    if (rule.type === "allowlist") {
      if (!Array.isArray(rule.values) || !rule.values.every((item) => typeof item === "string")) {
        errors.push(`${at}.values must be an array of strings.`);
      }
    }
    if (rule.type === "time_window") {
      const windows = rule.allow_utc_hours;
      if (
        !Array.isArray(windows) ||
        !windows.length ||
        !windows.every(
          (window) =>
            Array.isArray(window) &&
            window.length === 2 &&
            window.every((hour) => typeof hour === "number" && hour >= 0 && hour <= 24) &&
            window[0] < window[1],
        )
      ) {
        errors.push(`${at}.allow_utc_hours must contain increasing [start, end] pairs within 0–24.`);
      }
    }
  });
  return errors;
}

export function parsePolicyJson(source: string): { policy?: Policy; errors: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return { errors: [`Invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`] };
  }
  const errors = validatePolicyObject(value);
  return errors.length ? { errors } : { policy: value as Policy, errors: [] };
}

export const DEFAULT_INLINE_POLICY = JSON.stringify(
  {
    name: "console-inline",
    rules: [
      { type: "spend_limit", per_tx: 200, daily: 1000 },
      { type: "require_approval", when_amount_over: 100 },
      { type: "allowlist", field: "destination", values: ["0xapproved"], mode: "on" },
    ] satisfies PolicyRule[],
  },
  null,
  2,
);
