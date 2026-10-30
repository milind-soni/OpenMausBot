#!/usr/bin/env node
// The sidecar: `node companion/src/index.ts`. Running it is the opt-in.
//
//   :8810  0.0.0.0    devices     token required, allowlisted, scrubbed
//   :8811  127.0.0.1  you         pairing and revocation, never off-machine
//   :8799  127.0.0.1  the harness spoken to as this machine, unmodified
//   UDS/pipe            one Electron-owned sidecar generation, never TCP
import { createServer } from "node:http";

import { createAddressWatcher } from "./advertise-watch.ts";
import { createControlServer, hostCandidates, initialControlToken } from "./control.ts";
import { createConnectedDeviceTracker } from "./connected-devices.ts";
import { DeviceRegistry } from "./devices.ts";
import { companionEndpointCandidates, hostedCompanionUrl } from "./endpoints.ts";
import { lanAddresses, refreshTailnetName, tailnetName, tailscaleAddress } from "./listener.ts";
import {
  advertisableAddresses,
  clampBytes,
  defaultHostName,
  dnsLabel,
  MdnsResponder,
  type ServiceInfo,
} from "./mdns.ts";
import { notifyDeviceRevoked } from "./harness-notice.ts";
import { createProxyHandler } from "./proxy.ts";
import { companionOriginSocket, listenCompanionOrigin } from "./origin.ts";
import { gzipTunnelReplies } from "./tunnel-gzip.ts";
import { normalizedPhoneSecretPublicKey } from "./phone-secret-key.ts";

// Only Electron supplies this port; Electron children fail closed until initialized.
const parentPort = (process as NodeJS.Process & {
  parentPort?: { on(event: "message", listener: (event: { data?: unknown }) => void): void };
}).parentPort;
let mutationToken: string | null = null;
let controlToken = initialControlToken(process.env, Boolean(parentPort));
let controlTokenReceived = (): void => {};
const controlReady = controlToken ? Promise.resolve() : new Promise<void>((resolve) => { controlTokenReceived = resolve; });
parentPort?.on("message", ({ data }) => {
  if (!data || typeof data !== "object") return;
  const message = data as Record<string, unknown>;
  if (message.type !== "openmausbot:companion-mutation-token") return;
  if (typeof message.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(message.token)) {
    mutationToken = message.token;
  }
  if (controlToken === null && typeof message.controlToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(message.controlToken)) {
    controlToken = message.controlToken;
    controlTokenReceived();
  }
});

/** A typo'd port must not become port 0. */
const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
};

const HARNESS_PORT = num(process.env.OMB_PORT, 8799);
const WEBHOOK_PORT = num(process.env.OMB_WEBHOOK_PORT, HARNESS_PORT + 1);
const COMPANION_PORT = num(process.env.OMB_COMPANION_PORT, 8810);
const CONTROL_PORT = num(process.env.OMB_CONTROL_PORT, 8811);
const SERVICE_TYPE = "_openmausbot._tcp";
let hostedUrl = hostedCompanionUrl(process.env.OMB_COMPANION_HOSTED_URL);
const PRIVATE_ORIGIN = companionOriginSocket(process.env.OMB_COMPANION_INTERNAL_ORIGIN);
const SECRET_PUBLIC_KEY = normalizedPhoneSecretPublicKey(
  process.env.OMB_PHONE_SECRET_PUBLIC_KEY ?? "",
);

/** Checked up front: the collision is a race, and the loser's error surfaces
 * nowhere near here. */
const HARNESS_PORTS = new Map([
  [HARNESS_PORT, "the harness itself"],
  [WEBHOOK_PORT, "the harness's webhook receiver"],
]);

const conflict = (name: string, port: number): string | null => {
  const owner = HARNESS_PORTS.get(port);
  return owner ? `${name} is set to port ${port}, which is ${owner}` : null;
};

/** OMB_COMPANION_NAME wins; otherwise the harness's profile name, read once at
 * startup. Failures fall back: no part of pairing depends on the name. */
let cachedName = process.env.OMB_COMPANION_NAME?.trim() || "";

const machineName = (): string => cachedName || "OpenMausBot";

async function refreshMachineName(): Promise<void> {
  if (cachedName) return;
  try {
    const res = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const config = (await res.json()) as { profile?: { name?: string } };
    const owner = config.profile?.name?.trim();
    if (owner) cachedName = `${owner}'s computer`;
  } catch {
  }
}

const devices = new DeviceRegistry();
const mdns = new MdnsResponder();

/** Advertise when a network appears, re-advertise when DHCP moves us, withdraw
 * when it goes. */
const watcher = createAddressWatcher({
  addresses: advertisableAddresses,
  advertise: () => mdns.advertise(service()),
  withdraw: () => mdns.stop(),
  log: (line) => console.log(`bonjour: ${line}`),
});

const service = (): ServiceInfo => ({
  name: dnsLabel(machineName()),
  type: SERVICE_TYPE,
  port: COMPANION_PORT,
  host: defaultHostName(),
  addresses: advertisableAddresses(),
  txt: ["v=1", `name=${clampBytes(machineName(), 200)}`],
});

const connectedDevices = createConnectedDeviceTracker();
const proxy = createProxyHandler({
    harnessPort: HARNESS_PORT,
    mutationToken: parentPort ? () => mutationToken : undefined,
    // Also stamps lastSeenAt.
    authenticate: (token) => devices.authenticate(token),
    redeem: (code, deviceName, pairRequestId) => devices.redeem(code, deviceName, pairRequestId),
    serverName: machineName,
    hosts: () => hostCandidates(),
    endpoints: () => companionEndpointCandidates(COMPANION_PORT, undefined, undefined, hostedUrl),
    connected: connectedDevices.open,
  });
const companion = createServer(proxy);
// `createServer(proxy)` handles plain HTTP only; noVNC's WebSocket arrives as
// Node's separate `upgrade` event.
companion.on("upgrade", proxy.upgrade);
// Large JSON replies go gzipped here: this is the only listener whose replies go up the home connection to Cloudflare.
const managedOrigin = PRIVATE_ORIGIN ? createServer(gzipTunnelReplies(proxy)) : null;
managedOrigin?.on("upgrade", proxy.upgrade);

const control = createControlServer({
  devices,
  controlToken: () => controlToken,
  companionPort: COMPANION_PORT,
  secretPublicKey: () => SECRET_PUBLIC_KEY,
  hostedUrl: () => hostedUrl,
  setHostedUrl: (next) => {
    hostedUrl = next;
  },
  discovery: () => ({ advertising: mdns.advertising, name: service().name }),
  connectedDeviceIds: connectedDevices.ids,
  disconnectDevice: (deviceId) => {
    connectedDevices.disconnect(deviceId);
    proxy.disconnectDevice(deviceId);
  },
  // The harness hears a phone as this computer, so only the sidecar can tell
  // it the phone lost access and end the Live call that phone holds.
  revoked: (deviceId) => {
    if (parentPort && !mutationToken) return;
    void notifyDeviceRevoked({ harnessPort: HARNESS_PORT, deviceId, mutationToken: mutationToken ?? undefined });
  },
  refreshTailscale: () => refreshTailnetName(),
});

const listen = (server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      const hint = ` — another copy of the companion may already be running; ${
        port === COMPANION_PORT ? "OMB_COMPANION_PORT" : "OMB_CONTROL_PORT"
      } chooses a different one`;
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use${hint}`)
          : error,
      );
    };
    const onListening = () => {
      server.removeListener("error", onError);
      // A listening socket still emits `error` (EMFILE on accept, a vanished
      // interface), and an unhandled one is an uncaught exception.
      server.on("error", (error: NodeJS.ErrnoException) => {
        console.warn(`companion: error on ${host}:${port} — ${error.message}`);
      });
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

async function main(): Promise<void> {
  const clash =
    conflict("OMB_COMPANION_PORT", COMPANION_PORT) ?? conflict("OMB_CONTROL_PORT", CONTROL_PORT);
  if (clash) throw new Error(`${clash}. Pick another port.`);

  // 127.0.0.1 and 0.0.0.0 on one port collide; name it rather than EADDRINUSE.
  if (COMPANION_PORT === CONTROL_PORT) {
    throw new Error(
      `OMB_COMPANION_PORT and OMB_CONTROL_PORT are both port ${COMPANION_PORT}, and they cannot share one: ` +
        `the first is open to your network and the second must never be. Pick another port.`,
    );
  }

  await controlReady;
  await listen(control, CONTROL_PORT, "127.0.0.1");
  await listen(companion, COMPANION_PORT, "0.0.0.0");
  if (managedOrigin && PRIVATE_ORIGIN) {
    await listenCompanionOrigin(managedOrigin, PRIVATE_ORIGIN);
  }

  // Before advertising: renaming later would show the phone two computers.
  await refreshMachineName();

  const tailscaleTried: string[] = [];
  await refreshTailnetName((cli, outcome) => tailscaleTried.push(`  ${cli} — ${outcome}`)).catch(() => {});

  // Through the watcher: a laptop may have no addresses yet, and they change
  // under a running sidecar. Discovery failing is never fatal.
  await watcher.check();
  watcher.start();

  const addresses = lanAddresses();
  const tailscale = tailscaleAddress(addresses);
  const reach = tailnetName() ?? tailscale ?? addresses[0];
  console.log(`companion  http://0.0.0.0:${COMPANION_PORT}  →  harness 127.0.0.1:${HARNESS_PORT}`);
  if (!parentPort) console.log(`pair here  http://127.0.0.1:${CONTROL_PORT}/#token=${controlToken}`);
  if (reach) console.log(`on your phone, enter  ${reach}:${COMPANION_PORT}`);
  if (tailscale && !tailnetName()) {
    console.log("no MagicDNS name found. Tailscale CLI attempts:");
    for (const line of tailscaleTried) console.log(line);
  }
}

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} — stopping`);
  // The watcher first, or a tick could re-advertise the withdrawn record.
  watcher.stop();
  await mdns.stop().catch(() => {});
  // close() waits for open connections, and an SSE stream never ends on its own.
  proxy.closeViewers();
  companion.closeAllConnections?.();
  control.closeAllConnections?.();
  managedOrigin?.closeAllConnections?.();
  await Promise.all([
    new Promise<void>((r) => companion.close(() => r())),
    new Promise<void>((r) => control.close(() => r())),
    ...(managedOrigin ? [new Promise<void>((r) => managedOrigin.close(() => r()))] : []),
  ]);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
