import { describe, expect, it } from "vitest";
import { buildTokenForest, decodeTokenEnvelope, descendantRecords, formatDuration } from "./token";
import type { TokenEnvelope, TokenRecord } from "./types";

function encode(envelope: TokenEnvelope): string {
  return btoa(JSON.stringify(envelope)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const root = { aud: "root", scopes: ["read", "pay"], iat: 1, exp: 4_000_000_000, parent: null, tid: "root-tid" };
const child = { aud: "worker", scopes: ["read"], iat: 2, exp: 4_000_000_000, parent: "root-tid", tid: "child-tid" };

function record(chain: TokenEnvelope["chain"]): TokenRecord {
  return { token: encode({ chain, sig: "test-signature" }), createdAt: "2026-07-18T00:00:00Z", verification: "unknown" };
}

describe("client-side token tools", () => {
  it("decodes the documented envelope without claiming verification", () => {
    const envelope = decodeTokenEnvelope(record([root, child]).token);
    expect(envelope.chain.map((segment) => segment.aud)).toEqual(["root", "worker"]);
  });

  it("builds parent-child trees from held leaf tokens", () => {
    const forest = buildTokenForest([record([root]), record([root, child])]);
    expect(forest).toHaveLength(1);
    expect(forest[0].children[0].segment.tid).toBe("child-tid");
    expect(forest[0].children[0].depth).toBe(1);
  });

  it("finds an ancestor's complete affected subtree", () => {
    expect(descendantRecords([record([root]), record([root, child])], "root-tid")).toHaveLength(2);
  });

  it("rejects malformed envelopes", () => {
    expect(() => decodeTokenEnvelope("not-a-token")).toThrow(/base64url JSON/);
  });

  it("formats countdowns for the workbench", () => {
    expect(formatDuration(3_661)).toBe("1h 1m");
    expect(formatDuration(61)).toBe("1m 1s");
  });
});
