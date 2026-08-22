import { createHmac, timingSafeEqual } from "node:crypto";

const NONCE = /^[0-9a-f-]{36}$/i;
const BOOT_ID = /^[0-9a-f-]{36}$/i;
const PROOF = /^sha256:[0-9a-f]{64}$/;
const MAX_USED_NONCES = 2_048;
const PROOF_TTL_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const BOOTSTRAP_TIMEOUT_MS = 5_000;
const BOOTSTRAP_TYPE = "openmaus.agent-graph-authority.v1";

export interface AgentGraphDesktopBootstrap {
  type: typeof BOOTSTRAP_TYPE;
  secret: string;
  bootId: string;
}

export interface AgentGraphDesktopAuthority {
  bootId: string;
  issuedAt: number;
  nonce: string;
  proof: string;
}

function parseBootstrap(value: unknown): { secret: string; bootId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<AgentGraphDesktopBootstrap>;
  if (
    candidate.type !== BOOTSTRAP_TYPE || typeof candidate.secret !== "string" ||
    candidate.secret.length < 32 || candidate.secret.length > 256 ||
    typeof candidate.bootId !== "string" || !BOOT_ID.test(candidate.bootId)
  ) return null;
  return { secret: candidate.secret, bootId: candidate.bootId };
}

/**
 * Receive per-boot authority over Electron's private utility-process port or
 * Node's test-only IPC channel. Secrets in environment variables remain
 * visible to same-UID process-table inspection on macOS even after deletion.
 */
export async function receiveAgentGraphDesktopBootstrap(): Promise<{ secret: string; bootId: string }> {
  if (process.env.OMB_AGENT_GRAPH_APPROVAL_IPC !== "1") return { secret: "", bootId: "" };
  const electronPort = (process as NodeJS.Process & {
    parentPort?: { once(event: "message", listener: (event: { data?: unknown } | unknown) => void): void };
  }).parentPort;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const eventValue = value && typeof value === "object" && "data" in value
        ? (value as { data?: unknown }).data
        : value;
      resolve(parseBootstrap(eventValue) ?? { secret: "", bootId: "" });
    };
    const timer = setTimeout(() => finish(null), BOOTSTRAP_TIMEOUT_MS);
    if (electronPort?.once) electronPort.once("message", finish);
    else if (typeof process.once === "function") process.once("message", finish);
    else finish(null);
  });
}

function canonical(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, visit(nested)]),
    );
  };
  return JSON.stringify(visit(value));
}

export function signAgentGraphDesktopAction(
  secret: string,
  action: string,
  path: string,
  body: unknown,
  nonce: string,
  issuedAt: number,
  bootId: string,
): string {
  return `sha256:${createHmac("sha256", secret).update(canonical({ action, body, bootId, issuedAt, nonce, path })).digest("hex")}`;
}

/** One-use proof verifier for mutations forwarded by the Electron main process. */
export class AgentGraphDesktopGate {
  private readonly secret: string | null;
  private readonly bootId: string | null;
  private readonly used = new Map<string, number>();

  constructor(
    secret = "",
    bootId = "",
  ) {
    this.secret = secret.length >= 32 ? secret : null;
    this.bootId = BOOT_ID.test(bootId) ? bootId : null;
  }

  available(): boolean {
    return this.secret !== null && this.bootId !== null;
  }

  consume(action: string, path: string, body: unknown, authority: unknown): boolean {
    if (!this.secret || !this.bootId || !authority || typeof authority !== "object" || Array.isArray(authority)) return false;
    const candidate = authority as Partial<AgentGraphDesktopAuthority>;
    if (
      !candidate.nonce || !candidate.proof || candidate.bootId !== this.bootId ||
      !NONCE.test(candidate.nonce) || !PROOF.test(candidate.proof) ||
      !Number.isSafeInteger(candidate.issuedAt)
    ) return false;
    const now = Date.now();
    const issuedAt = candidate.issuedAt!;
    if (issuedAt < now - PROOF_TTL_MS || issuedAt > now + MAX_FUTURE_SKEW_MS) return false;
    for (const [usedNonce, usedAt] of this.used) {
      if (usedAt < now - PROOF_TTL_MS) this.used.delete(usedNonce);
    }
    if (this.used.has(candidate.nonce)) return false;
    if (this.used.size >= MAX_USED_NONCES) return false;
    const expected = signAgentGraphDesktopAction(this.secret, action, path, body, candidate.nonce, issuedAt, this.bootId);
    const left = Buffer.from(expected);
    const right = Buffer.from(candidate.proof);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
    this.used.set(candidate.nonce, issuedAt);
    return true;
  }
}
