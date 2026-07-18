import { useEffect, useMemo, useRef, useState } from "react";
import { checkGuard } from "../api";
import { ApiErrorBox, EmptyState, JsonPanel, PageHeader, StatusChip, formatDate } from "../components/UI";
import { DEFAULT_INLINE_POLICY, parsePolicyJson } from "../policy";
import { loadHistory, loadPreference, makeConsoleAgentId, saveHistory, savePreference } from "../storage";
import type { GuardRequest, GuardResponse, Policy, VerdictHistoryItem } from "../types";

const PRESETS = ["conservative", "standard", "permissive"];

export default function VerdictLab({
  initialPolicy,
  onApproval,
}: {
  initialPolicy: Policy | null;
  onApproval: (id: string) => void;
}) {
  const [agentId, setAgentId] = useState(() => loadPreference("lab-agent") || makeConsoleAgentId());
  const [amount, setAmount] = useState("150");
  const [destination, setDestination] = useState("0xapproved");
  const [action, setAction] = useState("transfer");
  const [policyMode, setPolicyMode] = useState<"preset" | "inline">("preset");
  const [preset, setPreset] = useState("standard");
  const [policySource, setPolicySource] = useState(DEFAULT_INLINE_POLICY);
  const [history, setHistory] = useState(loadHistory);
  const [response, setResponse] = useState<GuardResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pendingNavigation = useRef<number | null>(null);

  useEffect(() => {
    if (!initialPolicy) return;
    setPolicyMode("inline");
    setPolicySource(JSON.stringify({ ...initialPolicy, name: `${initialPolicy.name}-copy` }, null, 2));
  }, [initialPolicy]);

  useEffect(() => () => {
    if (pendingNavigation.current) window.clearTimeout(pendingNavigation.current);
  }, []);

  const parsedPolicy = useMemo(() => parsePolicyJson(policySource), [policySource]);

  async function execute(request: GuardRequest) {
    setBusy(true);
    setError(null);
    try {
      const result = await checkGuard(request);
      setResponse(result);
      const item: VerdictHistoryItem = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        request,
        response: result,
      };
      setHistory((items) => saveHistory([item, ...items]));
      if (result.verdict === "review" && result.approval_id) {
        pendingNavigation.current = window.setTimeout(() => onApproval(result.approval_id!), 900);
      }
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  }

  function requestFromForm(): GuardRequest | null {
    const numericAmount = Number(amount);
    if (!agentId.trim() || !Number.isFinite(numericAmount) || numericAmount < 0) {
      setError(new Error("Agent ID and a non-negative numeric amount are required."));
      return null;
    }
    if (policyMode === "inline" && (!parsedPolicy.policy || parsedPolicy.errors.length)) {
      setError(new Error("Fix the inline policy before sending it."));
      return null;
    }
    savePreference("lab-agent", agentId.trim());
    return {
      agent_id: agentId.trim(),
      amount: numericAmount,
      ...(action.trim() ? { action: action.trim() } : {}),
      ...(destination.trim() ? { destination: destination.trim() } : {}),
      policy: policyMode === "preset" ? preset : parsedPolicy.policy,
    };
  }

  function loadRequest(request: GuardRequest) {
    setAgentId(request.agent_id);
    setAmount(String(request.amount));
    setAction(request.action || "transfer");
    setDestination(request.destination || "");
    if (typeof request.policy === "string") {
      setPolicyMode("preset");
      setPreset(request.policy);
    } else if (request.policy) {
      setPolicyMode("inline");
      setPolicySource(JSON.stringify(request.policy, null, 2));
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <section>
      <PageHeader
        eyebrow="Spend-policy playground"
        title="Ask before the agent acts."
        description="Send a real free guard check, see every fired rule, and hand review verdicts to a real human on Telegram."
      />

      <div className="lab-layout">
        <form
          className="panel form-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const request = requestFromForm();
            if (request) void execute(request);
          }}
        >
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">Proposed action</p>
              <h2>Build the request</h2>
            </div>
            <StatusChip tone={agentId.startsWith("console-") ? "allow" : "review"}>
              {agentId.startsWith("console-") ? "demo-safe ID" : "custom ID"}
            </StatusChip>
          </div>

          <label>
            Agent ID
            <input value={agentId} onChange={(event) => setAgentId(event.target.value)} autoComplete="off" />
            <small>Console-generated IDs always begin with <code>console-</code>.</small>
          </label>
          <div className="form-row">
            <label>
              Amount
              <input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>
            <label>
              Action
              <input value={action} onChange={(event) => setAction(event.target.value)} />
            </label>
          </div>
          <label>
            Destination
            <input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="0x… or service name" />
          </label>

          <fieldset className="segmented-field">
            <legend>Policy source</legend>
            <div className="segmented">
              <button type="button" className={policyMode === "preset" ? "active" : ""} onClick={() => setPolicyMode("preset")}>Preset</button>
              <button type="button" className={policyMode === "inline" ? "active" : ""} onClick={() => setPolicyMode("inline")}>Inline JSON</button>
            </div>
          </fieldset>

          {policyMode === "preset" ? (
            <label>
              Preset
              <select value={preset} onChange={(event) => setPreset(event.target.value)}>
                {PRESETS.map((name) => <option key={name}>{name}</option>)}
              </select>
            </label>
          ) : (
            <label>
              Inline policy
              <textarea className="code-editor" rows={15} value={policySource} onChange={(event) => setPolicySource(event.target.value)} spellCheck={false} />
              <span className={parsedPolicy.errors.length ? "validation bad" : "validation good"}>
                {parsedPolicy.errors.length ? parsedPolicy.errors[0] : "Valid policy · four supported primitives only"}
              </span>
            </label>
          )}

          <div className="judge-callout">
            <strong>Judge mode</strong>
            <span>A standard-policy amount above 100 triggers review and buzzes the owner’s real phone. Approval expires after about 120 seconds.</span>
          </div>
          <button className="button primary full" disabled={busy} type="submit">
            {busy ? "Checking policy…" : "Get verdict"}
          </button>
        </form>

        <div className="result-column">
          <ApiErrorBox error={error} />
          {response ? (
            <article className={`verdict-result panel verdict-${response.verdict}`}>
              <p className="eyebrow">Deterministic verdict</p>
              <div className="verdict-heading">
                <StatusChip tone={response.verdict}>{response.verdict}</StatusChip>
                <span>{response.policy_used} policy</span>
              </div>
              <h2>{response.verdict === "allow" ? "The action fits the box." : response.verdict === "review" ? "A human now holds the pull cord." : "The action crossed a hard boundary."}</h2>
              <div className="reason-list">
                {response.reasons.map((reason) => <div key={reason}><span>→</span>{reason}</div>)}
              </div>
              {response.triggered_rules.length > 0 && (
                <div className="rule-tags">{response.triggered_rules.map((rule) => <code key={rule}>{rule}</code>)}</div>
              )}
              {response.approval_id && <p className="handoff-note">Opening approval <code>{response.approval_id}</code>…</p>}
              <JsonPanel value={response} />
            </article>
          ) : (
            <EmptyState title="No verdict yet">Build a request on the left. The API response will stay legible here—even when it fails.</EmptyState>
          )}
        </div>
      </div>

      <section className="history-section">
        <div className="section-heading">
          <div><p className="eyebrow">This browser only</p><h2>Verdict history</h2></div>
          {history.length > 0 && <button className="button ghost small" type="button" onClick={() => setHistory(saveHistory([]))}>Clear history</button>}
        </div>
        {history.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Agent</th><th>Amount</th><th>Policy</th><th>Verdict</th><th /></tr></thead>
              <tbody>
                {history.map((item) => (
                  <tr key={item.id}>
                    <td>{formatDate(item.createdAt)}</td>
                    <td><code>{item.request.agent_id}</code></td>
                    <td>{item.request.amount}</td>
                    <td>{typeof item.request.policy === "string" ? item.request.policy : item.request.policy?.name || "inline"}</td>
                    <td><StatusChip tone={item.response.verdict}>{item.response.verdict}</StatusChip></td>
                    <td><button className="text-button" type="button" onClick={() => loadRequest(item.request)}>Load again</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="History is empty">The last 30 checks are stored locally. Nothing is uploaded beyond the request you send.</EmptyState>}
      </section>
    </section>
  );
}
