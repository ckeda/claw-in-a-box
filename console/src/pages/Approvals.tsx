import { useEffect, useMemo, useState } from "react";
import { ApiError, getApproval, getApprovalFeed } from "../api";
import type { ApprovalResponse } from "../types";
import { ApiErrorBox, CopyButton, EmptyState, PageHeader, StatusChip, formatDate } from "../components/UI";
import { loadOperatorKey } from "../storage";

export default function Approvals({ initialApprovalId }: { initialApprovalId: string }) {
  const [input, setInput] = useState(initialApprovalId);
  const [watchedId, setWatchedId] = useState(initialApprovalId);
  const [approval, setApproval] = useState<ApprovalResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now());
  const [pollDelay, setPollDelay] = useState(3_000);
  const [feed, setFeed] = useState<ApprovalResponse[]>([]);
  const [feedStatus, setFeedStatus] = useState("");
  const [feedBusy, setFeedBusy] = useState(false);
  const operatorKey = loadOperatorKey();

  useEffect(() => {
    if (initialApprovalId) {
      setInput(initialApprovalId);
      setWatchedId(initialApprovalId);
    }
  }, [initialApprovalId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!watchedId) return;
    let stopped = false;
    let timer = 0;
    let nextDelay = 3_000;
    const poll = async () => {
      try {
        const data = await getApproval(watchedId);
        if (stopped) return;
        setApproval(data);
        setError(null);
        nextDelay = 3_000;
        setPollDelay(nextDelay);
        if (data.status !== "pending") return;
      } catch (nextError) {
        if (stopped) return;
        setError(nextError);
        nextDelay =
          nextError instanceof ApiError && nextError.status === 429
            ? Math.max(nextDelay * 2, nextError.retryAfterMs || 6_000)
            : 5_000;
        setPollDelay(nextDelay);
      }
      if (!stopped) timer = window.setTimeout(poll, nextDelay);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [watchedId]);

  const elapsed = useMemo(() => {
    if (!approval?.created_at) return 0;
    return Math.max(0, Math.floor((now - new Date(approval.created_at).getTime()) / 1_000));
  }, [approval, now]);

  function startWatching() {
    const id = input.trim();
    if (!/^[A-Fa-f0-9]{16}$/.test(id)) {
      setError(new Error("Approval IDs are 16 hexadecimal characters."));
      return;
    }
    setApproval(null);
    setError(null);
    setWatchedId(id);
  }

  async function refreshFeed() {
    if (!operatorKey) {
      setError(new Error("Enter the operator bearer key in Access & Recovery for this session."));
      return;
    }
    setFeedBusy(true);
    setError(null);
    try {
      const result = await getApprovalFeed(operatorKey, feedStatus, 50);
      setFeed(result.approvals);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setFeedBusy(false);
    }
  }

  const statusTone = approval?.status === "approved" ? "allow" : approval?.status === "pending" ? "review" : approval ? "deny" : "neutral";

  return (
    <section>
      <PageHeader
        eyebrow="Human-in-the-loop"
        title="Watch the decision happen."
        description="Paste an approval ID—or arrive here from Verdict Lab—and the Console polls politely until the human decides or the request expires."
      />

      <div className="approval-search panel">
        <label>
          Approval ID
          <div className="input-action">
            <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="a1b2c3d4e5f60708" autoComplete="off" />
            <button className="button primary" type="button" onClick={startWatching}>Watch</button>
          </div>
        </label>
        <p>Minimum poll interval: 3 seconds. Current interval: {(pollDelay / 1_000).toFixed(0)} seconds.</p>
      </div>

      <ApiErrorBox error={error} />

      <div className="operator-feed panel">
        <div className="panel-title-row">
          <div><p className="eyebrow">Operator session</p><h2>Live approval feed</h2></div>
          <StatusChip tone={operatorKey ? "review" : "neutral"}>{operatorKey ? "god-view active" : "key required"}</StatusChip>
        </div>
        <div className="feed-controls">
          <label>Status<select value={feedStatus} onChange={(event) => setFeedStatus(event.target.value)}><option value="">All</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="denied">Denied</option><option value="expired">Expired</option></select></label>
          <button className="button secondary" type="button" disabled={feedBusy} onClick={() => void refreshFeed()}>{feedBusy ? "Loading…" : "Refresh feed"}</button>
        </div>
        <p className="muted-note">This reads the existing approximately 30-minute live feed. The bearer key is sent only in the Authorization header.</p>
        {feed.length > 0 && (
          <div className="table-wrap feed-table"><table><thead><tr><th>Status</th><th>Approval</th><th>Agent</th><th>Amount</th><th>Destination</th><th>Created</th></tr></thead><tbody>
            {feed.map((item) => <tr key={item.approval_id} onClick={() => { setInput(item.approval_id); setWatchedId(item.approval_id); }}><td><StatusChip tone={item.status === "approved" ? "allow" : item.status === "pending" ? "review" : "deny"}>{item.status}</StatusChip></td><td><code>{item.approval_id}</code></td><td><code>{item.request.agent_id}</code></td><td>{item.request.amount}</td><td><code>{item.request.destination || "—"}</code></td><td>{formatDate(item.created_at)}</td></tr>)}
          </tbody></table></div>
        )}
      </div>

      {approval ? (
        <div className="approval-stage panel">
          <div className="approval-topline">
            <div>
              <p className="eyebrow">Approval {approval.approval_id}</p>
              <h2>{approval.status === "pending" ? "A real human’s phone just buzzed." : `Decision: ${approval.status}`}</h2>
            </div>
            <StatusChip tone={statusTone} pulse={approval.status === "pending"}>{approval.status}</StatusChip>
          </div>

          <div className="approval-clock">
            <strong>{elapsed}<small>s</small></strong>
            <span>{approval.status === "pending" ? "elapsed while waiting" : "from creation to this view"}</span>
          </div>

          <div className="timeline" aria-label="Approval timeline">
            <div className="timeline-step complete"><span>1</span><div><strong>Policy requested review</strong><small>{formatDate(approval.created_at)}</small></div></div>
            <div className={`timeline-step ${approval.status !== "pending" ? "complete" : "active"}`}><span>2</span><div><strong>Telegram notification delivered</strong><small>Approve and Deny are real server-side actions</small></div></div>
            <div className={`timeline-step ${approval.status !== "pending" ? "complete" : ""}`}><span>3</span><div><strong>{approval.status === "pending" ? "Waiting for the human" : approval.status === "approved" ? "Human approved" : approval.status === "denied" ? "Human denied" : "Expired: denied by default"}</strong><small>{approval.resolved_at ? formatDate(approval.resolved_at) : "No decision recorded yet"}</small></div></div>
          </div>

          <div className="approval-request">
            <div><span>Agent</span><code>{approval.request.agent_id}</code></div>
            <div><span>Action</span><strong>{approval.request.action}</strong></div>
            <div><span>Amount</span><strong>{approval.request.amount}</strong></div>
            <div><span>Destination</span><code>{approval.request.destination || "not provided"}</code></div>
          </div>

          {approval.final_verdict && (
            <div className={`final-verdict ${approval.final_verdict}`}>
              <span>Final verdict</span>
              <strong>{approval.final_verdict}</strong>
            </div>
          )}

          <CopyButton value={approval.approval_id} label="Copy approval ID" />
        </div>
      ) : (
        <EmptyState title={watchedId ? "Looking for this approval" : "No approval selected"}>
          {watchedId ? "The Console will show it as soon as the public API responds." : "Trigger review in Verdict Lab for the most convincing demo path."}
        </EmptyState>
      )}
    </section>
  );
}
