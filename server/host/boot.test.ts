// The boot walk must invoke the startup hook once even when an earlier bind
// attempt failed, and it must publish the bound-port request state inside the
// listen callback — before the webhook walk and before the first request.
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionCookieName } from "../request-auth.ts";
import { freePortBlock } from "../testing/ports.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { WebhookManager } from "../webhooks.ts";
import { bootServer, type ServerBoot } from "./boot.ts";

const HOST = "127.0.0.1";
const ENVIRONMENT_ID = "boot-fixture";

const servers: Array<Server | TcpServer> = [];

function holdPort(port: number): Promise<TcpServer> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(port, HOST, () => resolve(server));
    servers.push(server);
  });
}

function mainListener(): Server {
  const server = createServer((_req, res) => res.end());
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
});

describe("bootServer", () => {
  it("invokes the startup hook once after a failed first bind", async () => {
    const base = await freePortBlock([0, 1, 2]);
    await holdPort(base);
    const onListening = vi.fn();
    const bound = await bootServer({
      server: mainListener(),
      host: HOST,
      port: base,
      webhookPort: base + 2,
      pinned: false,
      assignPort: () => {},
      onListening,
      environmentId: ENVIRONMENT_ID,
      sessions: {} as SessionRegistry,
      closeSessionStreams: () => {},
      webhooks: {} as WebhookManager,
      webhookClaimRequest: () => () => {},
      log: () => {},
      error: () => {},
    });
    expect(bound.port).toBe(base + 1);
    // The failed attempt's listen callback must be removed: left registered it
    // fires with the successful attempt's and the hook runs twice.
    expect(onListening).toHaveBeenCalledTimes(1);
    bound.webhookIngress?.server.close();
  });

  it("publishes the bound-port session state inside the listen callback, before the webhook bind", async () => {
    const base = await freePortBlock([0, 1, 2]);
    const states: Pick<ServerBoot, "sessionCookie" | "workspaceAccess" | "workspaceAccessTimer" | "webhookIngressStatus">[] = [];
    let ingressAvailableAtHook: boolean | undefined;
    const bound = await bootServer({
      server: mainListener(),
      host: HOST,
      port: base,
      webhookPort: base + 1,
      pinned: false,
      assignPort: () => {},
      onBoundState: (state) => states.push(state),
      onListening: () => { ingressAvailableAtHook = states[0]?.webhookIngressStatus().available; },
      environmentId: ENVIRONMENT_ID,
      sessions: {} as SessionRegistry,
      closeSessionStreams: () => {},
      webhooks: {} as WebhookManager,
      webhookClaimRequest: () => () => {},
      log: () => {},
      error: () => {},
    });
    expect(states).toHaveLength(1);
    // The published cookie is keyed on the resolved port, and it is already
    // published when the startup hook (and any in-flight request) runs.
    expect(states[0]!.sessionCookie).toBe(sessionCookieName(base, ENVIRONMENT_ID));
    expect(ingressAvailableAtHook).toBe(false);
    expect(bound.webhookIngressStatus().available).toBe(true);
    bound.webhookIngress?.server.close();
  });
});
