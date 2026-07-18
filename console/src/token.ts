import type { TokenEnvelope, TokenRecord, TokenSegment } from "./types";

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function decodeTokenEnvelope(token: string): TokenEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(token.trim())));
  } catch {
    throw new Error("Token is not valid base64url JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Token envelope must be an object.");
  const envelope = parsed as Partial<TokenEnvelope>;
  if (!Array.isArray(envelope.chain) || envelope.chain.length === 0 || typeof envelope.sig !== "string") {
    throw new Error("Token envelope is missing chain or signature.");
  }
  envelope.chain.forEach((segment, index) => {
    if (
      !segment ||
      typeof segment.aud !== "string" ||
      !Array.isArray(segment.scopes) ||
      !segment.scopes.every((scope) => typeof scope === "string") ||
      typeof segment.iat !== "number" ||
      typeof segment.exp !== "number" ||
      typeof segment.tid !== "string"
    ) {
      throw new Error(`Token chain segment ${index} is malformed.`);
    }
  });
  return envelope as TokenEnvelope;
}

export interface TokenTreeNode {
  record: TokenRecord;
  segment: TokenSegment;
  depth: number;
  children: TokenTreeNode[];
}

export function leafForRecord(record: TokenRecord): TokenSegment {
  const chain = decodeTokenEnvelope(record.token).chain;
  return chain[chain.length - 1];
}

export function buildTokenForest(records: TokenRecord[]): TokenTreeNode[] {
  const nodes = new Map<string, TokenTreeNode>();
  for (const record of records) {
    try {
      const segment = leafForRecord(record);
      nodes.set(segment.tid, { record, segment, depth: 0, children: [] });
    } catch {
      // Invalid pasted tokens stay visible in the raw decoder but not in the tree.
    }
  }
  const roots: TokenTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.segment.parent ? nodes.get(node.segment.parent) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const assignDepth = (node: TokenTreeNode, depth: number) => {
    node.depth = depth;
    node.children.sort((a, b) => a.segment.iat - b.segment.iat);
    node.children.forEach((child) => assignDepth(child, depth + 1));
  };
  roots.sort((a, b) => a.segment.iat - b.segment.iat).forEach((root) => assignDepth(root, 0));
  return roots;
}

export function descendantRecords(records: TokenRecord[], ancestorTid: string): TokenRecord[] {
  return records.filter((record) => {
    try {
      const tids = decodeTokenEnvelope(record.token).chain.map((segment) => segment.tid);
      return tids.includes(ancestorTid);
    } catch {
      return false;
    }
  });
}

export function secondsRemaining(exp: number, now = Date.now()): number {
  return Math.max(0, Math.floor(exp - now / 1000));
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
