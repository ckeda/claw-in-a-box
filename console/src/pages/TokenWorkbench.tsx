import { useEffect, useMemo, useState } from "react";
import { ApiError, delegateToken, mintToken, revokeToken, verifyToken } from "../api";
import { ApiErrorBox, CopyButton, EmptyState, JsonPanel, PageHeader, StatusChip } from "../components/UI";
import { loadTokenRecords, saveTokenRecords } from "../storage";
import {
  buildTokenForest,
  decodeTokenEnvelope,
  descendantRecords,
  formatDuration,
  leafForRecord,
  secondsRemaining,
  type TokenTreeNode,
} from "../token";
import type { TokenEnvelope, TokenRecord, VerificationState } from "../types";

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function scopesFrom(value: string): string[] {
  return [...new Set(value.split(",").map((scope) => scope.trim()).filter(Boolean))];
}

function verificationFromError(error: unknown): VerificationState {
  if (error instanceof ApiError) {
    if (error.code === "revoked_ancestor") return "revoked";
    if (error.code === "expired" || error.code === "expired_ancestor") return "expired";
  }
  return "invalid";
}

function verificationTone(state: VerificationState): "allow" | "review" | "deny" | "neutral" {
  if (state === "valid") return "allow";
  if (state === "unknown") return "neutral";
  if (state === "expired") return "review";
  return "deny";
}

export default function TokenWorkbench() {
  const [records, setRecords] = useState(loadTokenRecords);
  const [subject, setSubject] = useState("console-root");
  const [rootScopes, setRootScopes] = useState("read, write, pay");
  const [rootTtl, setRootTtl] = useState("3600");
  const [presenter, setPresenter] = useState("");
  const [selectedParent, setSelectedParent] = useState<TokenRecord | null>(null);
  const [audience, setAudience] = useState("console-worker");
  const [childScopes, setChildScopes] = useState("read");
  const [childTtl, setChildTtl] = useState("600");
  const [decoderInput, setDecoderInput] = useState("");
  const [decoded, setDecoded] = useState<TokenEnvelope | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyAction, setBusyAction] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const forest = useMemo(() => buildTokenForest(records), [records]);

  function persist(next: TokenRecord[]) {
    const stored = saveTokenRecords(next);
    setRecords(stored);
    return stored;
  }

  function addToken(token: string) {
    decodeTokenEnvelope(token);
    persist([
      { token, createdAt: new Date().toISOString(), verification: "unknown" },
      ...records.filter((record) => record.token !== token),
    ]);
    setDecoderInput(token);
    setDecoded(decodeTokenEnvelope(token));
  }

  async function mintRoot() {
    const scopes = scopesFrom(rootScopes);
    if (!subject.trim() || !scopes.length) {
      setError(new Error("Subject and at least one scope are required."));
      return;
    }
    setBusyAction("mint");
    setError(null);
    try {
      const response = await mintToken({ subject: subject.trim(), scopes, ttl_seconds: Number(rootTtl) || 3600 });
      addToken(response.token);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusyAction("");
    }
  }

  async function delegate() {
    if (!selectedParent) return;
    const scopes = scopesFrom(childScopes);
    if (!audience.trim() || !scopes.length) {
      setError(new Error("Audience and at least one child scope are required."));
      return;
    }
    setBusyAction("delegate");
    setError(null);
    try {
      const response = await delegateToken({
        parent_token: selectedParent.token,
        audience: audience.trim(),
        scopes,
        ttl_seconds: Number(childTtl) || 600,
      });
      addToken(response.token);
      setSelectedParent(null);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusyAction("");
    }
  }

  async function verify(record: TokenRecord) {
    setBusyAction(`verify:${record.token}`);
    setError(null);
    try {
      const response = await verifyToken({ token: record.token, ...(presenter.trim() ? { presenter: presenter.trim() } : {}) });
      persist(records.map((item) => item.token === record.token ? { ...item, verification: "valid", verificationDetail: "API signature and attenuation checks passed", context: response.context } : item));
    } catch (nextError) {
      const verification = verificationFromError(nextError);
      persist(records.map((item) => item.token === record.token ? { ...item, verification, verificationDetail: nextError instanceof Error ? nextError.message : String(nextError) } : item));
      setError(nextError);
    } finally {
      setBusyAction("");
    }
  }

  async function revoke(record: TokenRecord) {
    const segment = leafForRecord(record);
    if (!window.confirm(`Revoke ${segment.aud}? Every descendant will fail verification.`)) return;
    setBusyAction(`revoke:${record.token}`);
    setError(null);
    try {
      await revokeToken(record.token);
      const affected = descendantRecords(records, segment.tid);
      let next = records.map((item) => affected.some((target) => target.token === item.token) ? { ...item, verification: "unknown" as const, verificationDetail: "Re-checking after ancestor revocation…" } : item);
      persist(next);
      for (const target of affected) {
        try {
          await verifyToken({ token: target.token });
          next = next.map((item) => item.token === target.token ? { ...item, verification: "valid", verificationDetail: "Still valid after cascade check" } : item);
        } catch (nextError) {
          next = next.map((item) => item.token === target.token ? { ...item, verification: verificationFromError(nextError), verificationDetail: nextError instanceof Error ? nextError.message : String(nextError) } : item);
        }
        persist(next);
        if (affected.length > 1) await sleep(1_000);
      }
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusyAction("");
    }
  }

  function decodeInput() {
    setError(null);
    try {
      setDecoded(decodeTokenEnvelope(decoderInput));
    } catch (nextError) {
      setDecoded(null);
      setError(nextError);
    }
  }

  function renderNode(node: TokenTreeNode) {
    const remaining = secondsRemaining(node.segment.exp, now);
    const isBusy = busyAction.endsWith(node.record.token);
    return (
      <div className={`token-branch depth-${Math.min(node.depth, 4)}`} key={node.segment.tid}>
        <article className={`token-node verification-${node.record.verification}`}>
          <div className="token-node-top">
            <div>
              <span className="token-depth">depth {node.depth}</span>
              <h3>{node.segment.aud}</h3>
            </div>
            <StatusChip tone={verificationTone(node.record.verification)}>{node.record.verification}</StatusChip>
          </div>
          <div className="token-meta">
            <div><span>Scopes</span><strong>{node.segment.scopes.join(" · ") || "none"}</strong></div>
            <div><span>Expires</span><strong className={remaining === 0 ? "danger-text" : ""}>{remaining ? formatDuration(remaining) : "expired"}</strong></div>
            <div><span>Token ID</span><code>{node.segment.tid}</code></div>
          </div>
          {node.record.verificationDetail && <p className="verification-detail">{node.record.verificationDetail}</p>}
          <div className="token-actions">
            <button className="button ghost small" type="button" disabled={isBusy} onClick={() => void verify(node.record)}>Verify</button>
            <button className="button ghost small" type="button" onClick={() => {
              setSelectedParent(node.record);
              setAudience(`console-worker-${node.depth + 1}`);
              setChildScopes(node.segment.scopes.includes("read") ? "read" : node.segment.scopes[0] || "read");
            }}>Delegate</button>
            <button className="button danger small" type="button" disabled={isBusy} onClick={() => void revoke(node.record)}>Revoke</button>
            <CopyButton value={node.record.token} label="Copy token" />
          </div>
        </article>
        {node.children.length > 0 && <div className="token-children">{node.children.map(renderNode)}</div>}
      </div>
    );
  }

  return (
    <section>
      <PageHeader
        eyebrow="Capability-token laboratory"
        title="Delegate less. Revoke once."
        description="Mint a root, attenuate it through several agents, inspect the chain locally, then revoke an ancestor and watch the whole subtree fail."
      />

      <ApiErrorBox error={error} />

      <div className="token-controls">
        <article className="panel form-panel compact">
          <p className="eyebrow">Step 1</p><h2>Mint a root</h2>
          <label>Subject<input value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
          <label>Scopes <small>Comma-separated</small><input value={rootScopes} onChange={(event) => setRootScopes(event.target.value)} /></label>
          <label>TTL seconds<input type="number" min="1" value={rootTtl} onChange={(event) => setRootTtl(event.target.value)} /></label>
          <button className="button primary full" type="button" disabled={busyAction === "mint"} onClick={() => void mintRoot()}>{busyAction === "mint" ? "Minting…" : "Mint root token"}</button>
        </article>

        <article className="panel form-panel compact">
          <p className="eyebrow">Verification context</p><h2>Who is presenting?</h2>
          <label>Presenter (optional)<input value={presenter} onChange={(event) => setPresenter(event.target.value)} placeholder="Must match the token audience" /></label>
          <p className="muted-note">Leave blank to verify signature, expiry, attenuation, and revocation only. Add a presenter to exercise <code>audience_mismatch</code>.</p>
          <div className="workbench-warning">Tokens are capabilities. This workbench keeps them only in this browser’s localStorage.</div>
        </article>
      </div>

      {selectedParent && (
        <article className="delegate-drawer panel">
          <div className="panel-title-row"><div><p className="eyebrow">Step 2</p><h2>Delegate from {leafForRecord(selectedParent).aud}</h2></div><button className="button ghost small" type="button" onClick={() => setSelectedParent(null)}>Close</button></div>
          <div className="form-row three">
            <label>Audience<input value={audience} onChange={(event) => setAudience(event.target.value)} /></label>
            <label>Scopes<input value={childScopes} onChange={(event) => setChildScopes(event.target.value)} /></label>
            <label>TTL seconds<input type="number" min="1" value={childTtl} onChange={(event) => setChildTtl(event.target.value)} /></label>
          </div>
          <p className="muted-note">Try adding a scope the parent does not have—the API will return the first-class <code>scope_escalation</code> error.</p>
          <button className="button primary" type="button" disabled={busyAction === "delegate"} onClick={() => void delegate()}>{busyAction === "delegate" ? "Delegating…" : "Create narrower child"}</button>
        </article>
      )}

      <section className="tree-section">
        <div className="section-heading"><div><p className="eyebrow">Live delegation graph</p><h2>Authority can only shrink</h2></div>{records.length > 0 && <button className="button ghost small" type="button" onClick={() => persist([])}>Clear workbench</button>}</div>
        {forest.length ? <div className="token-forest">{forest.map(renderNode)}</div> : <EmptyState title="No token tree yet">Mint a root above. Every child will attach to its parent by the cryptographic <code>parent</code> token ID.</EmptyState>}
      </section>

      <section className="decoder-section panel">
        <div className="section-heading"><div><p className="eyebrow">Client-side only</p><h2>Decode any token</h2></div><StatusChip tone="review">decoded ≠ verified</StatusChip></div>
        <textarea className="code-editor" rows={5} value={decoderInput} onChange={(event) => setDecoderInput(event.target.value)} placeholder="Paste a base64url token envelope" spellCheck={false} />
        <div className="button-row">
          <button className="button secondary" type="button" onClick={decodeInput}>Decode locally</button>
          <button className="button ghost" type="button" onClick={() => {
            try { addToken(decoderInput.trim()); } catch (nextError) { setError(nextError); }
          }}>Add to tree</button>
        </div>
        {decoded && <JsonPanel value={decoded} label="Untrusted decoded envelope" />}
      </section>
    </section>
  );
}
