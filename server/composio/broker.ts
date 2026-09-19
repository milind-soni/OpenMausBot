// Low-level Composio transport: managed-broker requests, project-key
// headers, error shaping, and Session fetch/parse.
import { z } from "zod";
import { apiBase, brokerAccess } from "./state.ts";

export const sessionResponseSchema = z.object({
  session_id: z.string().min(1),
  mcp: z.object({ type: z.enum(["http", "sse"]), url: z.string().min(1) }),
  config: z.object({
    user_id: z.string().optional(),
    multi_account: z.object({
      enable: z.boolean().optional(),
      max_accounts_per_toolkit: z.number().optional(),
      require_explicit_selection: z.boolean().optional(),
    }).optional(),
    /** toolkit slug → the project's own auth config the Session uses for it */
    auth_configs: z.record(z.string(), z.string()).optional(),
  }).optional(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export async function brokerRequest(path: string, init?: RequestInit): Promise<Response> {
  const broker = brokerAccess();
  if (!broker) throw new Error("The connected-apps service is unavailable");
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${broker.token}`);
  if (init?.body) headers.set("content-type", "application/json");
  return fetch(`${broker.url}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
}

export function projectHeaders(apiKey: string, json = false) {
  const headers = new Headers({ "x-api-key": apiKey });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

export async function responseError(res: Response, fallback: string) {
  const raw = await res.text().catch(() => "");
  try {
    const body = JSON.parse(raw);
    return String(body?.message ?? body?.error?.message ?? body?.error ?? fallback);
  } catch {
    return raw.trim().slice(0, 300) || fallback;
  }
}

export async function throwBrokerError(res: Response, fallback: string): Promise<never> {
  const status = res.status >= 400 && res.status < 500 ? res.status : 502;
  throw Object.assign(new Error(await responseError(res, fallback)), { status });
}

export function trustedAuthUrl(value: string | undefined, slug: string): string {
  if (!value) throw new Error(`Connected-apps service returned no authorization link for ${slug}`);
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "composio.dev" && !url.hostname.endsWith(".composio.dev"))) {
    throw new Error("Connected-apps service returned an untrusted authorization link");
  }
  return url.toString();
}

export function parseSessionResponse(session: SessionResponse): SessionResponse {
  const mcp = new URL(session.mcp.url);
  if (mcp.protocol !== "https:" || (mcp.hostname !== "composio.dev" && !mcp.hostname.endsWith(".composio.dev"))) {
    throw new Error("Composio returned an untrusted Session MCP URL");
  }
  return { ...session, mcp: { ...session.mcp, url: mcp.toString() } };
}

export function supportsMultiAccount(session: SessionResponse): boolean {
  // Only `enable` gates reuse. The cap and selection flags are what we ASK
  // for at creation; if Composio clamps or omits them in the echo, recreating
  // the Session would post the same config and get the same echo back — a
  // strict equality check here can only manufacture a recreate-per-request
  // loop, never fix anything.
  return session.config?.multi_account?.enable === true;
}

export function inputError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

export async function getProjectSession(apiKey: string, sessionId: string): Promise<SessionResponse | null> {
  const res = await fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}`, {
    headers: projectHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await responseError(res, `Composio session: HTTP ${res.status}`));
  return parseSessionResponse(sessionResponseSchema.parse(await res.json()));
}
