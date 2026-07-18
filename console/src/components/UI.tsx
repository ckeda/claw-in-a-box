import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../api";

export function StatusChip({
  tone = "neutral",
  children,
  pulse = false,
}: {
  tone?: "allow" | "review" | "deny" | "neutral" | "info";
  children: ReactNode;
  pulse?: boolean;
}) {
  return <span className={`status-chip ${tone}${pulse ? " pulse" : ""}`}>{children}</span>;
}

export function JsonPanel({ value, label = "API response" }: { value: unknown; label?: string }) {
  return (
    <div className="json-panel">
      <div className="json-label">{label}</div>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button className="button ghost small" type="button" onClick={copy}>
      {copied ? "Copied" : label}
    </button>
  );
}

export function ApiErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : null;
  return (
    <div className="error-box" role="alert">
      <strong>{apiError ? `${apiError.status} · ${apiError.code}` : "Request failed"}</strong>
      <span>{error instanceof Error ? error.message : String(error)}</span>
      {apiError?.status === 429 && <span>Polling has slowed down automatically.</span>}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {action && <div className="page-action">{action}</div>}
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function LoadingLine({ label = "Contacting the live service" }: { label?: string }) {
  return (
    <div className="loading-line" role="status">
      <span className="loading-dot" />
      {label}
    </div>
  );
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatUptime(totalSeconds = 0): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`].filter(Boolean).join(" ");
}
