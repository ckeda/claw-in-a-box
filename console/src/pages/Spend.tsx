import { useState } from "react";
import { getAgentSpend } from "../api";
import { ApiErrorBox, EmptyState, PageHeader, StatusChip, formatDate } from "../components/UI";
import { loadAgentCredential } from "../storage";
import type { SpendResponse } from "../types";

export default function Spend() {
  const credential = loadAgentCredential();
  const [data, setData] = useState<SpendResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!credential) {
      setError(new Error("Save an agent-owner credential in Access & Recovery first."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setData(await getAgentSpend(credential.agentId, credential.secret));
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <PageHeader
        eyebrow="Agent-owner view"
        title="See what changed the ledger."
        description="This view is scoped to one claimed agent by its X-Agent-Secret. History begins with v0.9 and shows the latest 50 changes only."
        action={<button className="button secondary" type="button" disabled={busy} onClick={() => void refresh()}>{busy ? "Loading…" : "Load spend"}</button>}
      />
      <ApiErrorBox error={error} />
      <div className="credential-context panel">
        <span>Agent credential</span>
        <strong>{credential?.agentId || "not configured"}</strong>
        <StatusChip tone={credential ? "allow" : "review"}>{credential ? "agent-scoped" : "required"}</StatusChip>
      </div>

      {data ? (
        <>
          <div className="spend-summary panel">
            <div><span>Day</span><strong>{data.day}</strong></div>
            <div><span>Spent today</span><strong>{data.spent_today}</strong></div>
            <div><span>Scope</span><strong>v0.9 · last 50</strong></div>
          </div>
          <div className="table-wrap spend-table">
            <table>
              <thead><tr><th>When</th><th>Change</th><th>Balance after</th><th>Reason</th><th>Reference</th></tr></thead>
              <tbody>
                {data.history.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDate(row.created_at)}</td>
                    <td><strong className={row.delta < 0 ? "danger-text" : ""}>{row.delta > 0 ? "+" : ""}{row.delta}</strong></td>
                    <td>{row.spent_after}</td>
                    <td><code>{row.reason}</code></td>
                    <td><code>{row.ref_id || "—"}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.history.length && <EmptyState title="No v0.9 ledger changes yet">Current spend can exist without older history; the append-only view starts at v0.9.</EmptyState>}
        </>
      ) : <EmptyState title="Agent spend is private">Load the saved agent-owner slot. The operator key cannot bypass this boundary.</EmptyState>}
    </section>
  );
}
