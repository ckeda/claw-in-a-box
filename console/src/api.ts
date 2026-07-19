import type {
  ApprovalResponse,
  ApprovalFeedResponse,
  BindingRegistration,
  GuardRequest,
  GuardResponse,
  HealthResponse,
  MetricsResponse,
  Policy,
  RecoveryChallenge,
  RecoveryResult,
  SpendResponse,
} from "./types";

export const API_BASE = import.meta.env.VITE_API_BASE || "https://test.clawinabox.xyz";

const STATIC_ENDPOINTS = new Set([
  "GET /healthz",
  "GET /v1/policies",
  "GET /v1/approvals",
  "GET /v1/metrics",
  "POST /v1/guard/check",
  "POST /v1/tokens",
  "POST /v1/tokens/delegate",
  "POST /v1/tokens/verify",
  "POST /v1/tokens/revoke",
  "POST /v1/operators/register",
  "POST /v1/agents/strict",
  "POST /v1/agents/recover",
]);

const DYNAMIC_ENDPOINTS = [
  { method: "GET", pattern: /^\/v1\/approvals\/[A-Za-z0-9_-]+$/ },
  { method: "GET", pattern: /^\/v1\/operators\/[^/]+$/ },
  { method: "GET", pattern: /^\/v1\/agents\/[^/]+\/spend$/ },
];

export class ApiError extends Error {
  status: number;
  code: string;
  detail: string;
  retryAfterMs?: number;

  constructor(status: number, code: string, detail: string, retryAfterMs?: number) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

export function assertFreeEndpoint(path: string, method = "GET"): void {
  const normalizedMethod = method.toUpperCase();
  const pathname = path.split("?", 1)[0];
  if (!pathname.startsWith("/") || pathname.startsWith("/paid")) {
    throw new Error("Console safety rail blocked a non-free API path");
  }
  const key = `${normalizedMethod} ${pathname}`;
  const dynamicMatch = DYNAMIC_ENDPOINTS.some(
    (entry) => entry.method === normalizedMethod && entry.pattern.test(pathname),
  );
  if (!STATIC_ENDPOINTS.has(key) && !dynamicMatch) {
    throw new Error(`Console safety rail blocked unknown endpoint: ${key}`);
  }
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(3_000, seconds * 1_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(3_000, date - Date.now());
  return undefined;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const method = String(init.method || "GET").toUpperCase();
  assertFreeEndpoint(path, method);

  const response = await fetcher(`${API_BASE}${path}`, {
    ...init,
    method,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ApiError(response.status, "invalid_response", "The API returned non-JSON data.");
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      String(payload.error || `http_${response.status}`),
      String(payload.detail || payload.error || response.statusText || "Request failed"),
      response.status === 429 ? retryAfterMs(response) || 6_000 : undefined,
    );
  }
  return payload as T;
}

const post = <T>(path: string, body: unknown) =>
  apiRequest<T>(path, { method: "POST", body: JSON.stringify(body) });

export const getHealth = () => apiRequest<HealthResponse>("/healthz");
export const getPolicies = () => apiRequest<{ presets: Policy[] }>("/v1/policies");
export const checkGuard = (body: GuardRequest) => post<GuardResponse>("/v1/guard/check", body);
export const getApproval = (id: string) =>
  apiRequest<ApprovalResponse>(`/v1/approvals/${encodeURIComponent(id.trim())}`);
export const getApprovalFeed = (operatorKey: string, status = "", limit = 25) =>
  apiRequest<ApprovalFeedResponse>(
    `/v1/approvals?${new URLSearchParams({ ...(status ? { status } : {}), limit: String(limit) })}`,
    { headers: { authorization: `Bearer ${operatorKey}` } },
  );
export const getAgentSpend = (agentId: string, secret: string) =>
  apiRequest<SpendResponse>(`/v1/agents/${encodeURIComponent(agentId.trim())}/spend`, {
    headers: { "X-Agent-Secret": secret },
  });
export const getMetrics = () => apiRequest<MetricsResponse>("/v1/metrics");
export const mintToken = (body: { subject: string; scopes: string[]; ttl_seconds?: number }) =>
  post<{ token: string }>("/v1/tokens", body);
export const delegateToken = (body: {
  parent_token: string;
  audience: string;
  scopes: string[];
  ttl_seconds?: number;
}) => post<{ token: string }>("/v1/tokens/delegate", body);
export const verifyToken = (body: { token: string; presenter?: string }) =>
  post<{ valid: true; context: Record<string, unknown> }>("/v1/tokens/verify", body);
export const revokeToken = (token: string) =>
  post<{ revoked_tid: string; cascades: true }>("/v1/tokens/revoke", { token });
export const registerOperator = (agentId: string, secret = "") =>
  apiRequest<BindingRegistration>("/v1/operators/register", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId }),
    headers: secret ? { "X-Agent-Secret": secret } : {},
  });
export const getOperatorRouting = (agentId: string) =>
  apiRequest<{ agent_id: string; routing: "caller" | "operator" }>(
    `/v1/operators/${encodeURIComponent(agentId.trim())}`,
  );
export const setStrictMode = (agentId: string, secret: string, strict: boolean) =>
  apiRequest<{ agent_id: string; strict_mode: boolean }>("/v1/agents/strict", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, strict }),
    headers: { "X-Agent-Secret": secret },
  });
export const issueRecoveryChallenge = (agentId: string) =>
  post<RecoveryChallenge>("/v1/agents/recover", { agent_id: agentId });
export const submitRecoverySignature = (agentId: string, nonce: string, signature: string) =>
  post<RecoveryResult>("/v1/agents/recover", { agent_id: agentId, nonce, signature });
