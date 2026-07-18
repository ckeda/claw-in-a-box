import { useEffect, useMemo, useState } from "react";
import { getOperatorRouting, registerOperator } from "../api";
import { ApiErrorBox, CopyButton, EmptyState, PageHeader, StatusChip } from "../components/UI";
import { loadPreference, makeConsoleAgentId, savePreference } from "../storage";
import type { BindingRegistration } from "../types";

export default function TelegramBinding() {
  const [agentId, setAgentId] = useState(() => loadPreference("binding-agent") || makeConsoleAgentId("binding"));
  const [registration, setRegistration] = useState<BindingRegistration | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [routing, setRouting] = useState<"caller" | "operator" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!registration || routing === "caller") return;
    let stopped = false;
    const check = async () => {
      if (Date.now() >= expiresAt) return;
      try {
        const result = await getOperatorRouting(registration.agent_id);
        if (!stopped) {
          setRouting(result.routing);
          setError(null);
        }
      } catch (nextError) {
        if (!stopped) setError(nextError);
      }
    };
    const timer = window.setInterval(() => void check(), 10_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [registration, routing, expiresAt]);

  const secondsLeft = useMemo(() => Math.max(0, Math.ceil((expiresAt - now) / 1_000)), [expiresAt, now]);
  const bindCommand = registration ? `/bind ${registration.bind_code}` : "";

  async function register() {
    if (!agentId.trim()) {
      setError(new Error("Agent ID is required."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await registerOperator(agentId.trim());
      savePreference("binding-agent", agentId.trim());
      setRegistration(result);
      setExpiresAt(Date.now() + result.expires_in_seconds * 1_000);
      setRouting("operator");
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  }

  async function verifyRouting() {
    setBusy(true);
    setError(null);
    try {
      const result = await getOperatorRouting(agentId.trim());
      setRouting(result.routing);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <PageHeader
        eyebrow="Multi-tenant approval routing"
        title="Put the pull cord on your phone."
        description="Register an agent, send one short command to the Claw-in-a-Box bot, and verify that future review requests route to you."
      />

      <ApiErrorBox error={error} />

      <div className="binding-layout">
        <article className="panel form-panel">
          <p className="eyebrow">Step 1</p><h2>Request a bind code</h2>
          <label>
            Agent ID
            <input value={agentId} onChange={(event) => setAgentId(event.target.value)} />
            <small>Choose a private, unguessable ID for real use. Console demos start with <code>console-</code>.</small>
          </label>
          <button className="button primary full" type="button" disabled={busy} onClick={() => void register()}>{busy ? "Requesting…" : "Generate 15-minute code"}</button>
          <p className="muted-note">Until binding completes, this agent’s review notifications go to the service operator.</p>
        </article>

        {registration ? (
          <article className="panel bind-ticket">
            <div className="ticket-topline"><span>ONE-TIME TELEGRAM CODE</span><StatusChip tone={secondsLeft ? "review" : "deny"}>{secondsLeft ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}` : "expired"}</StatusChip></div>
            <div className="bind-code">{registration.bind_code}</div>
            <ol className="bind-steps">
              <li><span>1</span><p>Open Telegram and find the <strong>Claw-in-a-Box bot</strong>.</p></li>
              <li><span>2</span><p>Press Start, then send this exact command:</p></li>
            </ol>
            <div className="command-box"><code>{bindCommand}</code><CopyButton value={bindCommand} /></div>
            <div className="ticket-actions">
              <button className="button secondary" type="button" disabled={busy} onClick={() => void verifyRouting()}>Verify routing now</button>
              <StatusChip tone={routing === "caller" ? "allow" : "review"} pulse={routing !== "caller"}>{routing === "caller" ? "bound to caller" : "still routes to operator"}</StatusChip>
            </div>
            {routing === "caller" && <div className="binding-success"><strong>Binding confirmed.</strong><span>Future review requests for <code>{registration.agent_id}</code> will arrive in your Telegram chat.</span></div>}
          </article>
        ) : (
          <EmptyState title="Your bind ticket will appear here">No account is created. The one-time code is kept only in service memory until it expires.</EmptyState>
        )}
      </div>

      <div className="honesty-panel">
        <strong>Phase 0 access model</strong>
        <p>This helper reflects the current public v0.7.5 API. Agent claiming and secret-protected rebinding arrive with the reviewed v0.8.1 security layer; the Console does not pretend frontend visibility is authentication.</p>
      </div>
    </section>
  );
}
