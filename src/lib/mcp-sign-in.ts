// Signing in to a URL MCP server from the desktop: the server starts the
// sign-in and listens for the browser's return on this machine; the app
// opens the sign-in page and waits for the server to report how it ended.

export type McpSignInPhase = "waiting" | "succeeded" | "failed" | "cancelled" | "expired";

export interface McpSignInStatus {
  phase: McpSignInPhase;
  flowId: string | null;
  authorizationUrl: string | null;
  expiresAt?: string;
  message?: string;
}

interface Deps {
  api: (path: string, init?: { method?: string; body?: string }) => Promise<any>;
  open: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const POLL_MS = 1_500;

/** Only an https page may be opened as a sign-in link. */
export function mcpSignInLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Start a sign-in for `name`, open its page, and resolve when it ends.
 * A start the server refuses (a remote workspace, a server without OAuth)
 * rejects with the server's message. */
export async function runMcpSignIn(name: string, deps: Deps): Promise<McpSignInStatus> {
  const base = `/api/mcp/servers/${encodeURIComponent(name)}/sign-in`;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cancel = () => deps.api(base, { method: "DELETE" }).catch(() => undefined);
  const started = (await deps.api(base, { method: "POST" })).auth as McpSignInStatus;
  if (started.phase !== "waiting") return started;
  const link = mcpSignInLink(started.authorizationUrl);
  if (!link || !started.flowId) {
    await cancel();
    return { ...started, phase: "failed", authorizationUrl: null };
  }
  await deps.open(link);
  let status = started;
  while (status.phase === "waiting") {
    await sleep(POLL_MS);
    if (deps.signal?.aborted) {
      await cancel();
      return { ...status, phase: "cancelled", authorizationUrl: null };
    }
    try {
      status = (await deps.api(`${base}/${started.flowId}`)).auth as McpSignInStatus;
    } catch {
      return { ...status, phase: "expired", authorizationUrl: null };
    }
  }
  return status;
}
