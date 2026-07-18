import { useEffect, useState } from "react";
import { getPolicies } from "../api";
import type { Policy, PolicyRule } from "../types";
import { ApiErrorBox, LoadingLine, PageHeader } from "../components/UI";

function ruleSentence(rule: PolicyRule): string {
  if (rule.type === "spend_limit") return `Per transaction ${rule.per_tx ?? "—"}; daily ${rule.daily ?? "—"}`;
  if (rule.type === "require_approval") return `Human review above ${rule.when_amount_over}`;
  if (rule.type === "allowlist") return rule.mode === "off" ? "Destination allowlist is off" : `${rule.values.length} allowed destinations`;
  return `UTC windows ${rule.allow_utc_hours.map(([start, end]) => `${start}:00–${end}:00`).join(", ")}`;
}

export default function Policies({ onUsePolicy }: { onUsePolicy: (policy: Policy) => void }) {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getPolicies()
      .then((response) => {
        if (!cancelled) setPolicies(response.presets);
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <PageHeader
        eyebrow="Published policy primitives"
        title="Rules an agent can explain."
        description="These cards come directly from the live API. Pick one to open an editable copy in Verdict Lab."
      />
      {loading && <LoadingLine label="Loading published presets" />}
      <ApiErrorBox error={error} />
      <div className="policy-grid">
        {policies.map((policy, index) => (
          <article className="policy-card panel" key={policy.name}>
            <div className="policy-index">0{index + 1}</div>
            <p className="eyebrow">Preset</p>
            <h2>{policy.name}</h2>
            <ul>
              {policy.rules.map((rule, ruleIndex) => (
                <li key={`${rule.type}-${ruleIndex}`}>
                  <code>{rule.type}</code>
                  <span>{ruleSentence(rule)}</span>
                </li>
              ))}
            </ul>
            <button className="button secondary full" type="button" onClick={() => onUsePolicy(policy)}>
              Use in Verdict Lab
            </button>
          </article>
        ))}
      </div>
      <div className="explain-strip">
        <strong>Evaluation order is simple.</strong>
        <span>Deny always wins over review. Only an allow increments today’s spend.</span>
      </div>
    </section>
  );
}
