import { describe, expect, it, vi } from "vitest";
import { apiRequest, assertFreeEndpoint } from "./api";

describe("Console API safety rail", () => {
  it("allows only declared free endpoints", () => {
    expect(() => assertFreeEndpoint("/healthz", "GET")).not.toThrow();
    expect(() => assertFreeEndpoint("/v1/approvals/a1b2c3d4e5f60708", "GET")).not.toThrow();
    expect(() => assertFreeEndpoint("/v1/operators/console-agent", "GET")).not.toThrow();
  });

  it("blocks every paid prefix before fetch", () => {
    expect(() => assertFreeEndpoint("/paid/v1/guard/check", "POST")).toThrow(/non-free/);
    expect(() => assertFreeEndpoint("/paid-okx/v1/tokens/verify", "POST")).toThrow(/non-free/);
  });

  it("blocks unknown and wrong-method endpoints", () => {
    expect(() => assertFreeEndpoint("/v1/metrics", "GET")).toThrow(/unknown endpoint/);
    expect(() => assertFreeEndpoint("/healthz", "POST")).toThrow(/unknown endpoint/);
  });

  it("never calls fetch when a route is blocked", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(apiRequest("/paid/v1/guard/check", { method: "POST" }, fetcher)).rejects.toThrow(/blocked/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces rate-limit backoff metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "rate_limited", detail: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "8" },
      }),
    );
    const request = apiRequest("/healthz", {}, fetcher);
    await expect(request).rejects.toMatchObject({ status: 429, code: "rate_limited", retryAfterMs: 8_000 });
  });
});
