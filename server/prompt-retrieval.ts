import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";

const RESPONSE_SCHEMA = "aos.openmausbot-retrieval-adapter.v1";
const CONTENT_TRUST = "untrusted_retrieval_evidence";
const DEFAULT_TIMEOUT_MS = 2_500;
const MAX_PROMPT_BYTES = 8_192;
const MAX_CONTEXT_BYTES = 768;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const NATIVE_EVENT = "pre_llm_call";
const NATIVE_SOURCE_MARKER = "openmausbot-native-v1";
const NATIVE_EVENT_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export type PromptRetrievalRequestKind =
  | "user_task"
  | "automation"
  | "continuation"
  | "delegation"
  | "room_turn"
  | "steer_attempt";

export interface PromptRetrievalOptions {
  cwd?: string;
  endpoint?: string;
  eventId?: string;
  fetchImpl?: typeof fetch;
  requestKind?: PromptRetrievalRequestKind;
  repositoryRemote?: string;
  repositoryRemoteResolver?: (cwd: string) => Promise<string | null>;
  timeoutMs?: number;
}

interface PromptRetrievalRequest {
  prompt: string;
  session_id: string;
  cwd?: string;
  native_event: typeof NATIVE_EVENT;
  native_event_id: string;
  repository_remote?: string;
  request_kind: PromptRetrievalRequestKind;
  source_marker: typeof NATIVE_SOURCE_MARKER;
}

export function normalizeRepositoryRemote(raw: string): string | null {
  let value = raw.trim();
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (!value || value.length > 300 || hasControlCharacter) return null;
  value = value.replace(/^git@github\.com:/i, "");
  value = value.replace(/^(?:https?|ssh|git):\/\/(?:git@)?github\.com\//i, "");
  value = value.replace(/^github\.com\//i, "");
  value = value.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value) ? value : null;
}

export async function repositoryRemoteForCwd(cwd: string): Promise<string | null> {
  // Resolve on every native event. A task may deliberately change its origin
  // in the same cwd; a path-only cache would then leak the prior project's
  // identity into retrieval until process restart.
  return new Promise<string | null>((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      { encoding: "utf8", maxBuffer: 4_096, timeout: 350, windowsHide: true },
      (error, stdout) => resolve(error ? null : normalizeRepositoryRemote(stdout)),
    );
  });
}

const AdapterResponseSchema = z.object({
  schema: z.literal(RESPONSE_SCHEMA),
  status: z.literal("context_ready"),
  surface: z.literal("openmausbot"),
  interface: z.literal("loopback"),
  context: z.string(),
  content_trust: z.literal(CONTENT_TRUST),
  instruction_authority: z.literal(false),
  tool_authority: z.literal(false),
  write_authority: z.literal(false),
  selector_authority: z.literal(false),
  promotion_authority: z.literal(false),
  prompt_or_content_recorded_by_adapter: z.literal(false),
  native_event: z.literal(NATIVE_EVENT),
  native_event_id: z.string(),
  session_key_hash: z.string().regex(/^[a-f0-9]{64}$/),
  request_kind: z.enum([
    "user_task", "automation", "continuation", "delegation", "room_turn",
    "steer_attempt",
  ]),
  source_marker: z.literal(NATIVE_SOURCE_MARKER),
});

type AdapterResponse = z.infer<typeof AdapterResponseSchema>;

function adapterUrl(raw: string | undefined): URL | null {
  if (!raw?.trim()) return null;
  try {
    const endpoint = new URL(raw.trim());
    if (
      endpoint.protocol !== "http:" ||
      !LOOPBACK_HOSTS.has(endpoint.hostname) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !["", "/", "/v1/retrieve"].includes(endpoint.pathname)
    ) {
      return null;
    }
    endpoint.pathname = "/v1/retrieve";
    return endpoint;
  } catch {
    return null;
  }
}

export function promptRetrievalConfiguration(raw = process.env.OMB_PROMPT_RETRIEVAL_URL) {
  const endpoint = adapterUrl(raw);
  return {
    configured: endpoint !== null,
    interface: "loopback",
    endpoint: endpoint ? endpoint.href : null,
    native_event: NATIVE_EVENT,
    source_marker: NATIVE_SOURCE_MARKER,
    context_ceiling_bytes: MAX_CONTEXT_BYTES,
  };
}

function acceptedContext(value: AdapterResponse): string | null {
  if (
    Buffer.byteLength(value.context, "utf8") > MAX_CONTEXT_BYTES ||
    !value.context.startsWith(
      '<fleet-retrieval-evidence trust="untrusted" instruction-authority="false">',
    ) ||
    !value.context.endsWith("</fleet-retrieval-evidence>")
  ) {
    return null;
  }
  return value.context;
}

/**
 * Fetch one bounded, non-authoritative retrieval block for an OpenMaus turn.
 *
 * The adapter is optional and loopback-only. Every configuration, transport,
 * timeout, or response-contract failure returns null without logging or
 * retaining the prompt. The caller appends accepted context only to the
 * provider-bound turn text, never to OpenMaus's durable transcript.
 */
export async function retrievePromptContext(
  prompt: string,
  sessionId: string,
  options: PromptRetrievalOptions = {},
): Promise<string | null> {
  const endpoint = adapterUrl(
    options.endpoint ?? process.env.OMB_PROMPT_RETRIEVAL_URL,
  );
  const eventId = options.eventId?.trim();
  const requestKind = options.requestKind;
  if (
    !endpoint ||
    !prompt.trim() ||
    Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES ||
    !sessionId.trim() ||
    !eventId ||
    !NATIVE_EVENT_ID.test(eventId) ||
    !requestKind
  ) {
    return null;
  }
  const normalizedCwd = options.cwd?.trim();
  const cwd = normalizedCwd && normalizedCwd.length <= 2_048 ? normalizedCwd : undefined;
  const explicitRemote = options.repositoryRemote
    ? normalizeRepositoryRemote(options.repositoryRemote)
    : null;
  const resolvedRemote = (
    cwd
      ? await (options.repositoryRemoteResolver ?? repositoryRemoteForCwd)(cwd).catch(() => null)
      : null
  );
  const repositoryRemote = explicitRemote ?? (
    resolvedRemote ? normalizeRepositoryRemote(resolvedRemote) : null
  );
  const timeoutMs = Math.max(
    100,
    Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  );
  try {
    const body: PromptRetrievalRequest = {
      prompt,
      session_id: sessionId,
      native_event: NATIVE_EVENT,
      native_event_id: eventId,
      request_kind: requestKind,
      source_marker: NATIVE_SOURCE_MARKER,
    };
    if (cwd) body.cwd = cwd;
    if (repositoryRemote) body.repository_remote = repositoryRemote;
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const value = AdapterResponseSchema.safeParse(await response.json());
    if (!value.success) return null;
    if (
      value.data.native_event_id !== eventId ||
      value.data.request_kind !== requestKind ||
      value.data.session_key_hash !== createHash("sha256").update(sessionId).digest("hex")
    ) {
      return null;
    }
    return acceptedContext(value.data);
  } catch {
    return null;
  }
}

export function appendPromptRetrievalContext(
  turnText: string,
  context: string | null,
): string {
  return context ? `${turnText}\n\n${context}` : turnText;
}
