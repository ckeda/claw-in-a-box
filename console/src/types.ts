export type Verdict = "allow" | "review" | "deny";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  features: Record<string, unknown> & {
    telegram_hitl?: boolean;
    payment_mode?: string;
    x402_sdk_ready?: boolean;
    cdp_x402_ready?: boolean;
    cdp_x402_enabled?: boolean;
    persistence?: {
      mode?: string;
      db_connected?: boolean;
      hydrated?: boolean;
      writes_ok?: number;
      writes_failed?: number;
      last_error?: string | null;
    };
  };
  memory: {
    heap_mb?: number;
    revoked?: number;
    spend_rows?: number;
    approvals?: number;
    settled?: number;
    bindings?: number;
    uptime_s?: number;
  };
}

export type PolicyRule =
  | { type: "spend_limit"; per_tx?: number; daily?: number }
  | { type: "require_approval"; when_amount_over: number }
  | { type: "allowlist"; field?: string; values: string[]; mode?: string }
  | { type: "time_window"; allow_utc_hours: [number, number][] };

export interface Policy {
  name: string;
  rules: PolicyRule[];
}

export interface GuardRequest {
  agent_id: string;
  amount: number;
  action?: string;
  destination?: string;
  policy?: string | Policy;
  wait?: boolean;
}

export interface GuardResponse {
  verdict: Verdict;
  triggered_rules: string[];
  reasons: string[];
  policy_used: string;
  agent_id: string;
  spent_today_after: number;
  evaluated_at: string;
  approval_id?: string;
  approval_status?: ApprovalStatus;
  poll?: string;
  note?: string;
}

export interface ApprovalResponse {
  approval_id: string;
  status: ApprovalStatus;
  final_verdict?: "allow" | "deny";
  request: {
    agent_id: string;
    action: string;
    amount: number;
    destination: string | null;
  };
  created_at: string;
  resolved_at?: string | null;
}

export interface TokenSegment {
  aud: string;
  scopes: string[];
  iat: number;
  exp: number;
  parent: string | null;
  tid: string;
}

export interface TokenEnvelope {
  chain: TokenSegment[];
  sig: string;
}

export type VerificationState = "unknown" | "valid" | "revoked" | "expired" | "invalid";

export interface TokenRecord {
  token: string;
  createdAt: string;
  verification: VerificationState;
  verificationDetail?: string;
  context?: Record<string, unknown>;
}

export interface VerdictHistoryItem {
  id: string;
  createdAt: string;
  request: GuardRequest;
  response: GuardResponse;
}

export interface BindingRegistration {
  agent_id: string;
  bind_code: string;
  expires_in_seconds: number;
  instructions: string;
  note?: string;
}
