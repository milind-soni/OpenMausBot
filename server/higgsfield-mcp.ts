import { IMAGE_MAX_BYTES } from "./attachments.ts";
import type { RemoteMcpSpec } from "./contracts.ts";
import { sniffRaster, type DecodedGeneratedImage } from "./generated-image.ts";
import { McpHttpError, McpRpcError, RemoteMcpClient } from "./mcp-http.ts";
import { withMcpSignIn, type McpOAuthManager } from "./mcp-oauth.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.ts";

const HIGGSFIELD_MCP_ORIGIN = "https://mcp.higgsfield.ai";
const HIGGSFIELD_MCP_PATH = "/mcp";
const HIGGSFIELD_DOMAIN = "higgsfield.ai";
const HIGGSFIELD_CDN_HOSTS: ReadonlySet<string> = new Set(["d8j0ntlcm91z4.cloudfront.net"]);

const IMAGE_DEADLINE_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_REDIRECTS = 3;
const POLL_DEFAULT_MS = 3_000;
const POLL_RANGE_S = { min: 1, max: 15 } as const;
const POLL_FAILURES = 3;
const REASON_LIMIT = 300;

const TERMINAL_FAILURES: ReadonlySet<string> = new Set(["canceled", "failed"]);
const BLOCKED: ReadonlySet<string> = new Set(["nsfw", "ip_detected"]);

type Json = Record<string, unknown>;

export class HiggsfieldError extends Error {
  readonly status: number;
  readonly neverStarted: boolean;
  constructor(message: string, status: number, neverStarted = false) {
    super(message);
    this.name = "HiggsfieldError";
    this.status = status;
    this.neverStarted = neverStarted;
  }
}

export interface HiggsfieldBackend {
  ready(): boolean;
  spec(): Promise<RemoteMcpSpec | null>;
  refused?(): Promise<"refreshed" | "ended" | "again" | "unknown">;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface HiggsfieldImage {
  bytes: Buffer;
  mime: DecodedGeneratedImage["mime"];
}

export interface HiggsfieldImageRequest {
  model: string;
  prompt: string;
  aspect?: "1:1" | "16:9" | "9:16";
}

const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value ? value : null);
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function isHiggsfieldAddress(url: string): boolean {
  let address: URL;
  try { address = new URL(url); } catch { return false; }
  if (address.search || address.hash || address.username || address.password) return false;
  return address.origin === HIGGSFIELD_MCP_ORIGIN && (address.pathname === HIGGSFIELD_MCP_PATH || address.pathname === `${HIGGSFIELD_MCP_PATH}/`);
}

export function createHiggsfieldBackend(deps: { servers: () => Record<string, unknown> | undefined; oauth: McpOAuthManager }): HiggsfieldBackend {
  const connection = () => {
    for (const [name, raw] of Object.entries(deps.servers() ?? {})) {
      const parsed = parseStoredMcpServer(name, raw);
      if (parsed.ok && isRemoteMcpServer(parsed.server) && "enabled" in parsed.server && parsed.server.enabled
        && parsed.server.type === "http" && isHiggsfieldAddress(parsed.server.url)) return { name, server: parsed.server };
    }
    return null;
  };
  return {
    ready: () => {
      const found = connection();
      return found !== null && deps.oauth.authState(found.name, found.server.url) === "signed-in";
    },
    spec: async () => {
      const found = connection();
      if (!found) return null;
      const signedIn = await withMcpSignIn({ [found.name]: found.server }, deps.oauth);
      const spec = signedIn[found.name];
      return spec && isRemoteMcpServer(spec) ? spec : null;
    },
    refused: async () => {
      const found = connection();
      return found ? deps.oauth.tokenRefused(found.name, found.server.url) : "unknown";
    },
  };
}

let backend: HiggsfieldBackend | null = null;

export function configureHiggsfield(next: HiggsfieldBackend | null): void {
  backend = next;
}

export function higgsfieldReady(): boolean {
  return backend?.ready() ?? false;
}

const signInAgain = () => new HiggsfieldError("Sign in to Higgsfield again in Plugins", 401, true);

function reasonOf(value: unknown): string | null {
  const line = typeof value === "string" ? value.replace(/https?:\/\/\S+/giu, "[link]").replace(/\s+/gu, " ").trim() : "";
  if (!line) return null;
  return line.length > REASON_LIMIT ? `${line.slice(0, REASON_LIMIT - 1)}…` : line;
}

function failure(reason: string | null, answer: Json | null = null): HiggsfieldError {
  const intent = text(answer?.monetization_intent);
  if (intent === "topup" || intent === "auto_refill" || (reason && /insufficient|not enough credits|out of credits/iu.test(reason))) {
    return new HiggsfieldError("Your Higgsfield account is out of credits", 402, true);
  }
  if (intent === "upgrade" || intent === "trial" || (reason && /subscription|upgrade|requires? [\w -]{0,24}plan|plan or higher/iu.test(reason))
    || answer?.upgrade_url !== undefined || answer?.recovery_tool === "show_plans_and_credits") {
    return new HiggsfieldError("This Higgsfield model needs a plan your account does not have", 403, true);
  }
  return new HiggsfieldError(reason ? `Higgsfield image generation failed: ${reason}` : "Higgsfield image generation failed", 502);
}

function toolValue(result: unknown): { value: Json | null; error: string | null } {
  if (!isRecord(result)) return { value: null, error: null };
  const block = (Array.isArray(result.content) ? result.content : []).find((item): item is { type: "text"; text: string } =>
    isRecord(item) && item.type === "text" && typeof item.text === "string");
  const parsed = (() => {
    if (isRecord(result.structuredContent)) return result.structuredContent;
    if (!block) return null;
    try {
      const value: unknown = JSON.parse(block.text);
      return isRecord(value) ? value : null;
    } catch { return null; }
  })();
  if (result.isError === true) return { value: null, error: reasonOf(parsed ? (parsed.error_hint ?? parsed.message ?? parsed.error) : block?.text) ?? "" };
  return { value: parsed, error: null };
}

function isHiggsfieldMedia(value: string): boolean {
  let address: URL;
  try { address = new URL(value); } catch { return false; }
  if (address.protocol !== "https:" || address.username || address.password) return false;
  const host = address.hostname.toLowerCase();
  return HIGGSFIELD_CDN_HOSTS.has(host) || host === HIGGSFIELD_DOMAIN || host.endsWith(`.${HIGGSFIELD_DOMAIN}`);
}

async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > limit) {
    await response.body?.cancel().catch(() => {});
    throw new HiggsfieldError("The generated image is larger than the limit", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => {});
      throw new HiggsfieldError("The generated image is larger than the limit", 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function download(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<HiggsfieldImage> {
  let address = url;
  let response: Response | null = null;
  for (let hop = 0; hop <= DOWNLOAD_REDIRECTS; hop += 1) {
    if (!isHiggsfieldMedia(address)) throw new HiggsfieldError("Higgsfield returned a file from an unexpected address", 502);
    const answer = await fetchImpl(address, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]), redirect: "manual" });
    const location = answer.status >= 300 && answer.status < 400 ? answer.headers.get("location") : null;
    if (!location) { response = answer; break; }
    await answer.body?.cancel().catch(() => {});
    address = URL.canParse(location, address) ? new URL(location, address).href : "";
  }
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => {});
    throw new HiggsfieldError("Could not download the generated image from Higgsfield", 502);
  }
  const bytes = await readCapped(response, IMAGE_MAX_BYTES);
  const mime = bytes.length > 0 ? sniffRaster(bytes) : null;
  if (!mime) throw new HiggsfieldError("The generated file is not a supported image", 502);
  return { bytes, mime };
}

const sleepFor = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", stop, { once: true });
});

function fileOf(generation: Json): string | null {
  const results = isRecord(generation.results) ? generation.results : records(generation.results)[0];
  const url = text(results?.rawUrl);
  return url && isHiggsfieldMedia(url) ? url : null;
}

function settled(generation: Json): string | HiggsfieldError | null {
  const status = (text(generation.status) ?? "").toLowerCase();
  if (status === "completed") return fileOf(generation) ?? new HiggsfieldError("Higgsfield finished without an image", 502);
  if (BLOCKED.has(status)) return new HiggsfieldError("Higgsfield's checks stopped this image", 422);
  if (TERMINAL_FAILURES.has(status)) return failure(reasonOf(generation.error));
  return null;
}

export async function generateHiggsfieldImage(request: HiggsfieldImageRequest, options: { signal?: AbortSignal } = {}): Promise<HiggsfieldImage> {
  const host = backend;
  if (!host) throw new HiggsfieldError("Connect Higgsfield in Plugins first", 409, true);
  const fetchImpl = host.fetchImpl ?? fetch;
  const sleep = host.sleep ?? sleepFor;
  const deadline = AbortSignal.timeout(IMAGE_DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const stopped = (): never => {
    if (options.signal?.aborted && !deadline.aborted) throw new HiggsfieldError("Image generation was cancelled", 409);
    throw new HiggsfieldError("Higgsfield took too long to make the image", 502);
  };

  const open = async (refreshed: boolean): Promise<RemoteMcpClient> => {
    const spec = await host.spec();
    if (!spec) throw signInAgain();
    const client = new RemoteMcpClient(spec, { fetch: fetchImpl });
    try {
      await client.initialize("OpenMausBot", signal);
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (signal.aborted) return stopped();
      if (error instanceof McpHttpError && error.status === 401) {
        if (!refreshed && host.refused && (await host.refused()) === "refreshed") return open(true);
        throw signInAgain();
      }
      throw new HiggsfieldError("Could not reach Higgsfield", 502, true);
    }
  };

  const client = await open(false);
  try {
    const call = async (name: string, args: Json): Promise<Json> => {
      let result: unknown;
      try {
        result = await client.request("tools/call", { name, arguments: args }, AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]));
      } catch (error) {
        if (signal.aborted) return stopped();
        if (error instanceof McpHttpError && error.status === 401) throw signInAgain();
        if (error instanceof McpRpcError) throw failure(reasonOf(error.detail));
        throw new HiggsfieldError("Higgsfield did not answer", 502);
      }
      const { value, error } = toolValue(result);
      if (error !== null) throw failure(error || null);
      if (!value) throw new HiggsfieldError("Higgsfield image generation failed", 502);
      if (value.error !== undefined || value.upgrade_url !== undefined || value.recovery_tool !== undefined || value.unlim_choice !== undefined) {
        throw failure(reasonOf(value.error), value);
      }
      return value;
    };

    const started = await call("generate_image", {
      params: { model: request.model, prompt: request.prompt, count: 1, use_unlim: false, aspect_ratio: request.aspect ?? "1:1" },
    });
    const job = records(started.results)[0];
    const id = text(job?.id);
    if (!job || !id) throw new HiggsfieldError("Higgsfield image generation failed", 502);

    let file = settled(job);
    for (let failures = 0; file === null;) {
      let answer: Json;
      try {
        answer = await call("job_status", { jobId: id, sync: true });
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= POLL_FAILURES || signal.aborted) throw error;
        await sleep(POLL_DEFAULT_MS, signal).catch(stopped);
        continue;
      }
      const generation = isRecord(answer.generation) ? answer.generation : null;
      if (!generation) throw new HiggsfieldError("Higgsfield image generation failed", 502);
      file = settled(generation);
      if (file === null) {
        const seconds = answer.poll_after_seconds;
        const wait = typeof seconds === "number" && Number.isFinite(seconds)
          ? Math.min(POLL_RANGE_S.max, Math.max(POLL_RANGE_S.min, seconds)) * 1000 : POLL_DEFAULT_MS;
        await sleep(wait, signal).catch(stopped);
      }
    }
    if (file instanceof HiggsfieldError) throw file;
    return await download(file, fetchImpl, signal).catch((error: unknown) => {
      if (signal.aborted) return stopped();
      throw error;
    });
  } finally {
    await client.close().catch(() => {});
  }
}
