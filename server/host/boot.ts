// The boot tail of server/index.ts: bind the listeners, then start what the
// bound port keys. When the configured port is busy an unpinned server walks
// forward to the first free port; a pinned child (the desktop parent,
// `openmausbot serve`, the verification harness) gets exactly one attempt —
// it must stay on the port its parent polls and simply fail. The webhook
// receiver binds in its own walk after the main port resolves so a busy
// webhook port cannot drag the main port forward and the walk never steals
// the resolved main port.
import type { Server } from "node:http";

import { createWorkspaceAccess, type WorkspaceAccess } from "../enterprise.ts";
import { sessionCookieName } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";
import { listenWebhookIngress, type IngressDoor, type WebhookIngress } from "../webhook-ingress.ts";
import type { WebhookManager } from "../webhooks.ts";

const PORT_FALLBACK_ATTEMPTS = 100;

function isEaddrinuse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EADDRINUSE";
}

/** Bind at `start` or the first free port above it while EADDRINUSE lets the
 * walk continue; a pinned server gets exactly one attempt. `exclude` keeps the
 * webhook walk off the port the main listener already resolved. Null when
 * every candidate was busy. */
async function bindFirstFreePort(options: {
  start: number;
  pinned: boolean;
  exclude?: (port: number) => boolean;
  bind: (port: number) => Promise<void>;
}): Promise<number | null> {
  const attempts = options.pinned ? 1 : PORT_FALLBACK_ATTEMPTS + 1;
  for (let offset = 0; offset < attempts; offset++) {
    const candidate = options.start + offset;
    if (options.exclude?.(candidate)) continue;
    try {
      await options.bind(candidate);
      return candidate;
    } catch (error) {
      if (options.pinned || !isEaddrinuse(error)) throw error;
    }
  }
  return null;
}

export interface ServerBoot {
  /** The port the main listener actually bound. */
  port: number;
  webhookPort: number;
  webhookIngress: WebhookIngress | null;
  /** /api/webhooks reads this per request: availability, the receiver's base URL, and its bind error when it is down. */
  webhookIngressStatus: () => { available: boolean; baseUrl: string; error?: string; starting?: boolean };
  /** Keyed on the bound port; consumers read it per request, so it is computed
   * only after the bind, never from the configured start port. Cookies are
   * not port-scoped — the name is the only thing separating two instances in
   * one browser profile. */
  sessionCookie: string;
  workspaceAccess: WorkspaceAccess | null;
  workspaceAccessTimer: NodeJS.Timeout | null;
}

/** /api/webhooks reads this until the listener publishes the real status on bind. */
export const startingIngressStatus: ServerBoot["webhookIngressStatus"] = () => ({ available: false, baseUrl: "", error: "the server is still starting", starting: true });

export async function bootServer(options: {
  server: Server;
  host: string;
  port: number;
  webhookPort: number;
  pinned: boolean;
  /** Writes each candidate back before its bind so live readers never see a stale port mid-walk. */
  assignPort: (port: number) => void;
  /** Fires in the listen callback, the moment the socket accepts, before
   * `onListening`: the request path must not read unset boot state while the
   * webhook walk is still pending. */
  onBoundState?: (state: {
    sessionCookie: string;
    workspaceAccess: WorkspaceAccess | null;
    workspaceAccessTimer: NodeJS.Timeout | null;
    webhookIngressStatus: ServerBoot["webhookIngressStatus"];
  }) => void;
  /** Fires in the listen callback, the moment the socket accepts. */
  onListening: () => void;
  environmentId: string;
  sessions: SessionRegistry;
  closeSessionStreams: (sessionId: string) => void;
  webhooks: WebhookManager;
  webhookSocketPath?: string;
  webhookPublicUrl?: string;
  webhookClaimRequest: () => () => void;
  webhookDoor?: IngressDoor;
  log?: (line: string) => void;
  error?: (line: string) => void;
}): Promise<ServerBoot> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  let sessionCookie = "";
  let workspaceAccess: WorkspaceAccess | null = null;
  let workspaceAccessTimer: NodeJS.Timeout | null = null;
  let webhookIngress: WebhookIngress | null = null;
  let webhookIngressError: string | null = null;
  let webhookPort = options.webhookPort;
  // True until the receiver walk settles below: a status read between the main
  // bind and that walk must answer starting, or the launcher relaunches a healthy child.
  let webhookBindPending = true;
  const webhookIngressStatus = () => ({
    available: Boolean(webhookIngress),
    baseUrl: webhookIngress?.baseUrl ?? `http://${options.host}:${webhookPort}`,
    ...(webhookBindPending ? { starting: true } : {}),
    ...(webhookIngressError ? { error: webhookIngressError } : {}),
  });
  const port = await bindFirstFreePort({
    start: options.port,
    pinned: options.pinned,
    bind: async (candidatePort) => {
      options.assignPort(candidatePort);
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          options.server.off("error", onError);
          try {
            sessionCookie = sessionCookieName(candidatePort, options.environmentId);
            const access = createWorkspaceAccess({ sessions: options.sessions, cookieName: sessionCookie, closeSessionStreams: options.closeSessionStreams });
            workspaceAccess = access;
            // With the bridge's five-second deadline, this bounds stale portal access on quiet streams to fifteen seconds.
            workspaceAccessTimer = access ? setInterval(() => {
              void access.revalidate().catch((revalidateError) => console.warn("workspace access revalidation failed", revalidateError));
            }, 10_000) : null;
            workspaceAccessTimer?.unref();
            options.onBoundState?.({ sessionCookie, workspaceAccess, workspaceAccessTimer, webhookIngressStatus });
            options.onListening();
            resolve();
          } catch (bootError) {
            reject(bootError);
          }
        };
        const onError = (listenError: Error) => {
          options.server.off("error", onError);
          options.server.off("listening", onListening);
          reject(listenError);
        };
        options.server.once("error", onError);
        options.server.listen(candidatePort, options.host, onListening);
      });
    },
  });
  if (port === null) {
    throw new Error(`could not find an available port after ${PORT_FALLBACK_ATTEMPTS + 1} attempts starting from ${options.port}`);
  }
  log(`openmausbot server on http://${options.host}:${port}`);

  try {
    const bound = await bindFirstFreePort({
      start: options.webhookPort,
      pinned: options.pinned,
      exclude: (candidate) => candidate === port,
      bind: async (candidateWebhookPort) => {
        webhookIngress = await listenWebhookIngress(options.webhooks, {
          port: candidateWebhookPort, socketPath: options.webhookSocketPath, publicBaseUrl: options.webhookPublicUrl,
          claimRequest: options.webhookClaimRequest, door: options.webhookDoor,
        });
      },
    });
    if (bound === null) throw new Error(`no free loopback port at or above ${options.webhookPort}`);
    webhookPort = bound;
    const advertised = options.webhookPublicUrl ? ` (advertised as ${webhookIngress!.baseUrl})` : "";
    log(`openmausbot webhook receiver on http://${webhookIngress!.host}:${webhookIngress!.port}${webhookIngress!.socketServer ? ` and ${options.webhookSocketPath}` : ""}${advertised}`);
  } catch (ingressError) {
    webhookIngressError = ingressError instanceof Error ? ingressError.message : String(ingressError);
    error(`openmausbot webhook receiver unavailable: ${webhookIngressError}`);
  } finally {
    webhookBindPending = false;
  }
  return { port, webhookPort, webhookIngress, webhookIngressStatus, sessionCookie, workspaceAccess, workspaceAccessTimer };
}
