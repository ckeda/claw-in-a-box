import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, getHealth } from "../api";
import type { HealthResponse } from "../types";
import { ApiErrorBox, formatUptime, LoadingLine, PageHeader, StatusChip } from "../components/UI";

function readyTone(value: unknown): "allow" | "review" | "deny" {
  if (value === true) return "allow";
  if (value === false) return "deny";
  return "review";
}

export default function Dashboard() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const data = await getHealth();
      setHealth(data);
      setError(null);
      setUpdatedAt(new Date());
      return 10_000;
    } catch (nextError) {
      setError(nextError);
      return nextError instanceof ApiError && nextError.status === 429
        ? Math.max(10_000, nextError.retryAfterMs || 20_000)
        : 15_000;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const loop = async () => {
      const delay = await refresh();
      if (!stopped) timer = window.setTimeout(loop, delay);
    };
    void loop();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [refresh, refreshSignal]);

  const persistence = health?.features.persistence;
  const collectionTotal = useMemo(
    () =>
      health
        ? ["revoked", "spend_rows", "approvals", "settled", "bindings"].reduce(
            (sum, key) => sum + Number(health.memory[key as keyof HealthResponse["memory"]] || 0),
            0,
          )
        : 0,
    [health],
  );

  return (
    <section>
      <PageHeader
        eyebrow="Live service telemetry"
        title="The service has a pulse."
        description="An honest view of the production API: payment readiness, memory pressure, collections, and uptime—without touching a paid route."
        action={
          <button className="button secondary" type="button" onClick={() => setRefreshSignal((value) => value + 1)}>
            Refresh now
          </button>
        }
      />

      {!health && !error && <LoadingLine />}
      <ApiErrorBox error={error} />

      {health && (
        <>
          <div className="hero-status panel">
            <div>
              <p className="eyebrow">api.clawinabox.xyz</p>
              <h2>
                {health.ok ? "Operational" : "Degraded"}
                <span className={`signal-orb ${health.ok ? "good" : "bad"}`} />
              </h2>
              <p>
                Version <code>{health.version}</code> · uptime {formatUptime(health.memory.uptime_s)} · refreshed {updatedAt?.toLocaleTimeString()}
              </p>
            </div>
            <div className="lobster-stamp" aria-hidden="true">CLAW<br />ONLINE</div>
          </div>

          <div className="metric-grid">
            <article className="metric-card">
              <span>Heap</span>
              <strong>{health.memory.heap_mb ?? "—"}<small> MB</small></strong>
              <p>Process heap currently in use</p>
            </article>
            <article className="metric-card">
              <span>Tracked state</span>
              <strong>{collectionTotal}</strong>
              <p>Rows across bounded memory collections</p>
            </article>
            <article className="metric-card">
              <span>Approvals</span>
              <strong>{health.memory.approvals ?? "—"}</strong>
              <p>Live approval records in memory</p>
            </article>
            <article className="metric-card">
              <span>Bindings</span>
              <strong>{health.memory.bindings ?? "—"}</strong>
              <p>Agent-to-Telegram routing entries</p>
            </article>
          </div>

          <div className="two-column">
            <article className="panel">
              <div className="panel-title-row">
                <div>
                  <p className="eyebrow">Payment rails</p>
                  <h2>Two rails, one engine</h2>
                </div>
              </div>
              <div className="rail-row">
                <div>
                  <strong>OKX · X Layer / USDT0</strong>
                  <p>Official OKX x402 SDK</p>
                </div>
                <StatusChip tone={readyTone(health.features.x402_sdk_ready)}>
                  {health.features.x402_sdk_ready ? "ready" : "not ready"}
                </StatusChip>
              </div>
              <div className="rail-row">
                <div>
                  <strong>Bazaar · Base / USDC</strong>
                  <p>Coinbase CDP facilitator</p>
                </div>
                <StatusChip tone={readyTone(health.features.cdp_x402_ready)}>
                  {health.features.cdp_x402_ready ? "ready" : "not ready"}
                </StatusChip>
              </div>
              <p className="muted-note">Readiness comes from <code>/healthz</code>. This Console never probes either paid route.</p>
            </article>

            <article className="panel">
              <p className="eyebrow">Persistence</p>
              <h2>{persistence ? `Mode: ${persistence.mode || "unknown"}` : "Not reported by this release"}</h2>
              {persistence ? (
                <div className="persistence-list">
                  <span>Database <StatusChip tone={persistence.db_connected ? "allow" : "review"}>{persistence.db_connected ? "connected" : "degraded"}</StatusChip></span>
                  <span>Hydration <strong>{persistence.hydrated ? "complete" : "not active"}</strong></span>
                  <span>Writes <strong>{persistence.writes_ok ?? 0} ok / {persistence.writes_failed ?? 0} failed</strong></span>
                </div>
              ) : (
                <p className="muted-note">Production v0.7.5 predates the persistence telemetry object. The v0.8.0 staging build adds it without inventing data here.</p>
              )}
            </article>
          </div>
        </>
      )}

      <section className="service-wall">
        <div>
          <p className="eyebrow">Receipts, not promises</p>
          <h2>The service is listed in the open.</h2>
        </div>
        <div className="market-links">
          <a href="https://www.okx.ai/agents/5854" target="_blank" rel="noreferrer">
            <span>OKX.AI</span><strong>ClawGuard ↗</strong>
          </a>
          <a href="https://agentic.market/services/api-clawinabox-xyz" target="_blank" rel="noreferrer">
            <span>x402 Bazaar</span><strong>Agentic.Market ↗</strong>
          </a>
          <a href="https://clawinabox.xyz/documentation.html" target="_blank" rel="noreferrer">
            <span>Protocol</span><strong>Documentation ↗</strong>
          </a>
        </div>
      </section>
    </section>
  );
}
