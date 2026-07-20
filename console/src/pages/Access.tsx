import { useState } from "react";
import { issueRecoveryChallenge, setStrictMode, submitRecoverySignature } from "../api";
import { ApiErrorBox, PageHeader, StatusChip } from "../components/UI";
import {
  clearAgentCredential,
  clearConsoleData,
  clearOperatorKey,
  loadAgentCredential,
  loadOperatorKey,
  saveAgentCredential,
  saveOperatorKey,
} from "../storage";

type EthereumProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

function messageHex(value: string): string {
  return `0x${Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export default function Access() {
  const savedAgent = loadAgentCredential();
  const [agentId, setAgentId] = useState(savedAgent?.agentId || "");
  const [secret, setSecret] = useState(savedAgent?.secret || "");
  const [operatorKey, setOperatorKey] = useState(loadOperatorKey());
  const [strict, setStrict] = useState<boolean | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  function saveAgent() {
    if (!agentId.trim() || !secret.trim()) {
      setError(new Error("Agent ID and secret are both required."));
      return;
    }
    saveAgentCredential({ agentId: agentId.trim(), secret: secret.trim() });
    setError(null);
    setNotice("Agent-owner credential saved in localStorage for this browser.");
  }

  function saveOperator() {
    if (!operatorKey.trim()) {
      setError(new Error("Operator key is required."));
      return;
    }
    saveOperatorKey(operatorKey.trim());
    setError(null);
    setNotice("Operator key saved for this browser session only.");
  }

  async function toggleStrict(value: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await setStrictMode(agentId.trim(), secret.trim(), value);
      setStrict(result.strict_mode);
      setNotice(`Strict mode is now ${result.strict_mode ? "on" : "off"}.`);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  }

  async function recover() {
    const ethereum = (window as typeof window & { ethereum?: EthereumProvider }).ethereum;
    if (!ethereum) {
      setError(new Error("No injected EVM wallet was found. Use an EOA wallet, or ask the operator for manual recovery."));
      return;
    }
    if (!agentId.trim()) {
      setError(new Error("Enter the claimed agent ID first."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const challenge = await issueRecoveryChallenge(agentId.trim());
      const accounts = await ethereum.request({ method: "eth_requestAccounts" }) as string[];
      const account = accounts[0];
      if (!account) throw new Error("The wallet returned no account.");
      const signature = await ethereum.request({ method: "personal_sign", params: [messageHex(challenge.message), account] }) as string;
      const result = await submitRecoverySignature(challenge.agent_id, challenge.nonce, signature);
      setSecret(result.agent_secret);
      saveAgentCredential({ agentId: result.agent_id, secret: result.agent_secret });
      setNotice("Recovery succeeded. The old secret is invalid; the new secret is saved in the agent-owner slot.");
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <PageHeader eyebrow="Credential boundaries" title="Three roles. Two storage lifetimes." description="Visitor access needs no key. Agent-owner access is single-agent; operator access is a god-view and intentionally disappears when the browser session ends." />
      <ApiErrorBox error={error} />
      {notice && <div className="success-note" role="status">{notice}</div>}

      <div className="access-grid">
        <article className="panel credential-card">
          <div className="panel-title-row"><div><p className="eyebrow">Slot 1</p><h2>Visitor</h2></div><StatusChip tone="info">no credential</StatusChip></div>
          <p>Dashboard metrics, policies, Verdict Lab, token tools, and individual approval lookup remain public.</p>
        </article>

        <article className="panel credential-card">
          <div className="panel-title-row"><div><p className="eyebrow">Slot 2</p><h2>Agent owner</h2></div><StatusChip tone={savedAgent ? "allow" : "review"}>localStorage</StatusChip></div>
          <label>Agent ID<input value={agentId} onChange={(event) => setAgentId(event.target.value)} autoComplete="username" /></label>
          <label>Agent secret<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="current-password" /></label>
          <div className="button-row">
            <button className="button primary small" type="button" onClick={saveAgent}>Save agent slot</button>
            <button className="button ghost small" type="button" onClick={() => { clearAgentCredential(); setAgentId(""); setSecret(""); setNotice("Agent-owner slot cleared."); }}>Clear</button>
          </div>
          <div className="strict-control">
            <span>Strict mode</span>
            <button className="button secondary small" type="button" disabled={busy || !agentId || !secret} onClick={() => void toggleStrict(true)}>Turn on</button>
            <button className="button ghost small" type="button" disabled={busy || !agentId || !secret} onClick={() => void toggleStrict(false)}>Turn off</button>
            {strict !== null && <StatusChip tone={strict ? "allow" : "neutral"}>{strict ? "on" : "off"}</StatusChip>}
          </div>
        </article>

        <article className="panel credential-card operator-card">
          <div className="panel-title-row"><div><p className="eyebrow">Slot 3</p><h2>Operator</h2></div><StatusChip tone={operatorKey ? "review" : "neutral"}>session only</StatusChip></div>
          <label>Bearer key<input type="password" value={operatorKey} onChange={(event) => setOperatorKey(event.target.value)} autoComplete="off" /></label>
          <div className="button-row">
            <button className="button primary small" type="button" onClick={saveOperator}>Use this session</button>
            <button className="button ghost small" type="button" onClick={() => { clearOperatorKey(); setOperatorKey(""); setNotice("Operator session slot cleared."); }}>Clear</button>
          </div>
          <p className="credential-warning">Never persisted in localStorage. Re-enter after closing this tab/session.</p>
        </article>
      </div>

      <div className="two-column access-actions">
        <article className="panel">
          <p className="eyebrow">Lost agent secret</p><h2>Recover with the claiming wallet</h2>
          <p>Connect the EOA recorded at settlement and sign the server's EIP-191 challenge. The signature authorizes secret rotation, not payment.</p>
          <button className="button secondary" type="button" disabled={busy} onClick={() => void recover()}>{busy ? "Waiting for wallet…" : "Sign recovery challenge"}</button>
          <p className="muted-note">v0.9 does not support EIP-1271 contract wallets or custodial claimers. Use manual operator recovery for those wallets.</p>
        </article>
        <article className="panel danger-zone">
          <p className="eyebrow">Browser reset</p><h2>Clear all Console data</h2>
          <p>Removes history, tokens, preferences, the agent-owner slot, and the operator session slot.</p>
          <button className="button danger" type="button" onClick={() => { if (window.confirm("Clear all Console data and credentials?")) { clearConsoleData(); setAgentId(""); setSecret(""); setOperatorKey(""); setNotice("All Console browser data cleared."); } }}>Clear all</button>
        </article>
      </div>
    </section>
  );
}
