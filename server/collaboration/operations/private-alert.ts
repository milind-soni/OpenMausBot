export interface SafeOperationalAlert {
  code: string;
  digest: string;
  occurredAt: number;
}

export interface PrivateOwnerAlertSink {
  sendPrivate(target: string, alert: Readonly<SafeOperationalAlert>): Promise<void>;
}

export interface PrivateOwnerAlertPort {
  alert(input: SafeOperationalAlert): Promise<void>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const SAFE_CODE = /^[a-z][a-z0-9_]{2,63}$/;
const SAFE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_FIELDS = new Set(["code", "digest", "occurredAt"]);

function validateTarget(target: string | null | undefined): string {
  const normalized = target?.trim() ?? "";
  if (!normalized) throw new Error("Private Owner alert target is not configured");
  if (normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Private Owner alert target is invalid");
  }
  return normalized;
}

function validateAlert(input: SafeOperationalAlert): Readonly<SafeOperationalAlert> {
  const keys = Object.keys(input as object);
  if (keys.length !== SAFE_FIELDS.size || keys.some((key) => !SAFE_FIELDS.has(key))) {
    throw new Error("Private Owner alerts accept only code, digest, and occurredAt");
  }
  if (!SAFE_CODE.test(input.code)) throw new Error("Private Owner alert code is not safe");
  if (!SAFE_DIGEST.test(input.digest)) throw new Error("Private Owner alert digest must be a SHA-256 digest");
  if (!Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
    throw new Error("Private Owner alert occurredAt must be a non-negative integer");
  }
  return Object.freeze({ code: input.code, digest: input.digest, occurredAt: input.occurredAt });
}

/**
 * A deliberately narrow operational channel. Project-group progress delivery
 * is not accepted here, and raw error text cannot cross this boundary.
 */
export class ValidatingPrivateOwnerAlertPort implements PrivateOwnerAlertPort {
  private readonly target: string | null | undefined;
  private readonly sink: PrivateOwnerAlertSink;

  constructor(target: string | null | undefined, sink: PrivateOwnerAlertSink) {
    this.target = target;
    this.sink = sink;
  }

  async alert(input: SafeOperationalAlert): Promise<void> {
    const target = validateTarget(this.target);
    const alert = validateAlert(input);
    await this.sink.sendPrivate(target, alert);
  }
}

/** Resolves the sole current Owner at send time so local recovery takes effect immediately. */
export class LedgerPrivateOwnerAlertPort implements PrivateOwnerAlertPort {
  private readonly database: DatabaseSync;
  private readonly sink: PrivateOwnerAlertSink;

  constructor(database: DatabaseSync, sink: PrivateOwnerAlertSink) {
    this.database = database;
    this.sink = sink;
  }

  async alert(input: SafeOperationalAlert): Promise<void> {
    const alert = validateAlert(input);
    const owner = this.database
      .prepare(
        "SELECT sender_corp_id, sender_staff_id FROM collaboration_owner_bindings WHERE active = 1",
      )
      .get() as { sender_corp_id: string; sender_staff_id: string } | undefined;
    if (!owner) throw new Error("Private Owner alert target is not configured");
    await this.sink.sendPrivate(validateTarget(`${owner.sender_corp_id}:${owner.sender_staff_id}`), alert);
  }
}

/**
 * Independent private-DM relay transport. The endpoint itself is a rotating
 * secure-file reference and is never returned through health or logs.
 */
export class FetchPrivateOwnerAlertSink implements PrivateOwnerAlertSink {
  private readonly webhookFile: string | null;
  private readonly fetcher: FetchLike;

  constructor(webhookFile: string | null, fetcher: FetchLike = fetch) {
    this.webhookFile = webhookFile;
    this.fetcher = fetcher;
  }

  async sendPrivate(target: string, input: Readonly<SafeOperationalAlert>): Promise<void> {
    if (!this.webhookFile) throw new Error("private_owner_alert_delivery_not_configured");
    const alert = validateAlert(input);
    const raw = readSecureCredentialFile(this.webhookFile);
    let endpoint: URL;
    try {
      endpoint = new URL(raw.toString("utf8").trim());
    } finally {
      raw.fill(0);
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error("private_owner_alert_endpoint_invalid");
    }
    const response = await this.fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: validateTarget(target), ...alert }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`private_owner_alert_http_${response.status}`);
  }
}
import type { DatabaseSync } from "node:sqlite";

import { readSecureCredentialFile } from "./credentials.ts";
