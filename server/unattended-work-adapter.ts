/**
 * Narrow loopback client for the dormant AOS unattended-work plane.
 *
 * This adapter has exactly three operations: health, submit, and status. It
 * cannot select a bot, start a turn, invoke a provider, run a repository tool,
 * or opt into the full-task-scoped profile. The source-owned work plane remains
 * responsible for validation, idempotency, card creation, and every execution
 * guard.
 */

import { z } from "zod";

const DEFAULT_BASE_URL = "http://127.0.0.1:8817";
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const PlaneResponseSchema = z.object({ error: z.string().optional() }).catchall(z.json());
const WorkRequestPayloadSchema = z.object({ ingress: z.literal("openmausbot").optional() }).catchall(z.json());
type PlaneResponse = z.infer<typeof PlaneResponseSchema>;
type WorkRequestPayload = z.input<typeof WorkRequestPayloadSchema>;

export function unattendedWorkRequestIdFromPath(path: string): string | null {
  const match = path.match(/^\/api\/unattended-work\/([^/]{1,480})$/);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return REQUEST_ID.test(decoded) ? decoded : null;
}

export class UnattendedWorkAdapterError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "UnattendedWorkAdapterError";
    this.status = status;
  }
}

export interface UnattendedWorkAdapterOptions {
  enabled?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface UnattendedWorkAdapterSnapshot {
  schema: "openmausbot.unattended-work-adapter.v1";
  enabled: boolean;
  source_ready: true;
  executor: "hermes";
  capabilities: readonly ["submit", "status"];
  runs_repo_tools: false;
  uses_full_task_profile: false;
}

export interface UnattendedWorkAdapterHealth {
  adapter: UnattendedWorkAdapterSnapshot;
  plane: PlaneResponse | null;
  status: "disabled" | "connected";
}

function validatedBaseUrl(raw: string): URL {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new UnattendedWorkAdapterError("unattended-work URL is invalid", 500);
  }
  if (
    value.protocol !== "http:" ||
    value.hostname !== "127.0.0.1" ||
    !value.port ||
    (value.pathname !== "/" && value.pathname !== "") ||
    value.username ||
    value.password ||
    value.search ||
    value.hash
  ) {
    throw new UnattendedWorkAdapterError(
      "unattended-work URL must be an explicit 127.0.0.1 HTTP port",
      500,
    );
  }
  return value;
}

function adapterSnapshot(enabled: boolean): UnattendedWorkAdapterSnapshot {
  return {
    schema: "openmausbot.unattended-work-adapter.v1",
    enabled,
    source_ready: true,
    executor: "hermes",
    capabilities: ["submit", "status"],
    runs_repo_tools: false,
    uses_full_task_profile: false,
  };
}

async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new UnattendedWorkAdapterError("unattended-work response is too large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new UnattendedWorkAdapterError("unattended-work response is too large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class UnattendedWorkAdapter {
  readonly enabled: boolean;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: UnattendedWorkAdapterOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.baseUrl = validatedBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new UnattendedWorkAdapterError("unattended-work timeout is invalid", 500);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  snapshot(): UnattendedWorkAdapterSnapshot {
    return adapterSnapshot(this.enabled);
  }

  async health(): Promise<UnattendedWorkAdapterHealth> {
    const adapter = this.snapshot();
    if (!this.enabled) return { adapter, plane: null, status: "disabled" };
    const plane = await this.request("/health");
    return { adapter, plane, status: "connected" };
  }

  async submit(payload: WorkRequestPayload): Promise<PlaneResponse> {
    this.requireEnabled();
    const parsed = WorkRequestPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new UnattendedWorkAdapterError("work request must be a JSON object with openmausbot ingress", 400);
    }
    const receipt = await this.request("/v1/work", {
      method: "POST",
      body: JSON.stringify({ ...parsed.data, ingress: "openmausbot" }),
    });
    if (receipt.live_accepted !== false) {
      throw new UnattendedWorkAdapterError("unattended-work returned a non-dormant receipt", 502);
    }
    return receipt;
  }

  async status(requestId: string): Promise<PlaneResponse> {
    this.requireEnabled();
    if (!REQUEST_ID.test(requestId)) {
      throw new UnattendedWorkAdapterError("work request id is invalid", 400);
    }
    return this.request(`/v1/work/${encodeURIComponent(requestId)}`);
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new UnattendedWorkAdapterError("OpenMausBot work ingress is disabled", 403);
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<PlaneResponse> {
    const target = new URL(path, this.baseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        ...init,
        headers: init.body ? { "content-type": "application/json" } : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error && error.name === "TimeoutError"
        ? "unattended-work request timed out"
        : "unattended-work service is unavailable";
      throw new UnattendedWorkAdapterError(message, 503);
    }
    const bytes = await boundedResponseBytes(response);
    let body: PlaneResponse;
    try {
      body = PlaneResponseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw new UnattendedWorkAdapterError("unattended-work returned invalid JSON");
    }
    if (!response.ok) {
      const detail = body.error ?? `unattended-work returned HTTP ${response.status}`;
      throw new UnattendedWorkAdapterError(detail, response.status);
    }
    return body;
  }
}

export function unattendedWorkAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): UnattendedWorkAdapter {
  return new UnattendedWorkAdapter({
    enabled: env.OMB_UNATTENDED_WORK_ENABLED === "1",
    baseUrl: env.OMB_UNATTENDED_WORK_URL || DEFAULT_BASE_URL,
    fetchImpl,
  });
}
