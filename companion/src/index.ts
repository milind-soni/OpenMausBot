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
import { MoveGrants } from "./move-grants.ts";
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
import { parseE2EMessage, parseRelayConfig, relayBaseUrlOverride, standaloneTransportKey, type RelayConfig } from "./e2e/config.ts";
import { b64u } from "./e2e/credentials.ts";
import { handleDirectUpgrade, isE2EUpgrade } from "./e2e/direct.ts";
import { CLOSE, TRANSPORT_RELAY } from "./e2e/noise.ts";
import { createE2EOrigin } from "./e2e/origin.ts";
import { E2ERegistry } from "./e2e/registry.ts";
import { RelayClient } from "./e2e/relay-client.ts";
import { companionOriginSocket, listenCompanionOrigin } from "./origin.ts";
import { gzipTunnelReplies } from "./tunnel-gzip.ts";
import { normalizedPhoneSecretPublicKey } from "./phone-secret-key.ts";
import { machineNameFromConfig } from "./machine-name.ts";

// Only Electron supplies this port; Electron children fail closed until initialized.
const parentPort = (process as NodeJS.Process & {
  parentPort?: {
    on(event: "message", listener: (event: { data?: unknown }) => void): void;
    postMessage(message: unknown): void;
  };
}).parentPort;
let mutationToken: string | null = null;
let controlToken = initialControlToken(process.env, Boolean(parentPort));
let controlTokenReceived = (): void => {};
const controlReady = controlToken ? Promise.resolve() : new Promise<void>((resolve) => { controlTokenReceived = resolve; });
parentPort?.on("message", ({ data }) => {
  if (!data || typeof data !== "object") return;
  const message = data as Record<string, unknown>;
  if (message.type === "openmausbot:companion-e2e") return void configureE2E(message);
  if (message.type === "openmausbot:companion-e2e-redial") return void relay?.redial();
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

/** OMB_COMPANION_NAME wins; otherwise the name set in Settings or the owner's profile name, re-read every 30
 * seconds so a rename, or a harness that answered late, reaches the phone. Failures keep the last name. */
const fixedName = process.env.OMB_COMPANION_NAME?.trim() || "";
let cachedName = fixedName;

const machineName = (): string => cachedName || "OpenMausBot";

/** True when the name changed. */
async function refreshMachineName(): Promise<boolean> {
  if (fixedName) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const next = machineNameFromConfig(await res.json());
    if (next === cachedName) return false;
    cachedName = next;
    return true;
  } catch {
    return false;
  }
}

let nameTimer: ReturnType<typeof setInterval> | null = null;
let stopping = false;

const devices = new DeviceRegistry();
const mdns = new MdnsResponder();
const e2e = new E2ERegistry(devices);
let relay: RelayClient | null = null;
const relayBaseUrl = relayBaseUrlOverride(process.env.OMB_COMPANION_RELAY_URL);

/** Advertise when a network appears, re-advertise when DHCP moves us, withdraw
 * when it goes. */
const watcher = createAddressWatcher({
  addresses: advertisableAddresses,
  name: machineName,
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
const moves = new MoveGrants();
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
    moves,
    askOwner: parentPort
      ? (ask) => {
          parentPort.postMessage({ type: "openmausbot:companion-move-ask", ...ask });
          return true;
        }
      : undefined,
    e2eDescriptor: (deviceId) => e2e.descriptor(deviceId),
    e2ePaired: (context, deviceId) => e2e.paired(context, deviceId),
  });
const e2eOrigin = createE2EOrigin((req, res) => proxy(req, res), (req, socket, head) => proxy.upgrade(req, socket, head));
const companion = createServer((req, res) => proxy(req, res, "lan"));
// `createServer` handles plain HTTP only; noVNC's WebSocket and /v1/e2e arrive as Node's separate `upgrade` event.
companion.on("upgrade", (req, socket, head) =>
  isE2EUpgrade(req) ? handleDirectUpgrade(req, socket, head, e2e, e2eOrigin) : proxy.upgrade(req, socket, head, "lan"));
// Large JSON replies go gzipped here: this is the only listener whose replies go up the home connection to Cloudflare.
const managedOrigin = PRIVATE_ORIGIN ? createServer(gzipTunnelReplies((req, res) => proxy(req, res, "origin"))) : null;
managedOrigin?.on("upgrade", (req, socket, head) => proxy.upgrade(req, socket, head, "origin"));

function applyRelay(config: RelayConfig | null): void {
  const sameHost = relay && config && e2e.relay?.hostId.equals(config.hostId);
  if (!config || !e2e.enabled || !sameHost) {
    relay?.stop();
    relay = null;
  }
  e2e.setRelay(config && e2e.enabled ? { hostId: config.hostId, nodes: config.nodes } : null);
  if (!config || !e2e.enabled) return;
  if (relay) return relay.setToken(config.token, config.nodes);
  relay = new RelayClient({
    nodes: config.nodes,
    token: config.token,
    admissionSet: () => e2e.admissionSet(),
    accept: (transport) => {
      const session = e2e.accept(transport, TRANSPORT_RELAY, "relay", (context) => e2eOrigin.connect(context));
      return session && { receive: (data, binary) => session.receive(data, binary), transportClosed: (code) => session.transportClosed(code) };
    },
    tokenRejected: () => parentPort?.postMessage({ type: "openmausbot:companion-e2e-token-rejected" }),
    statusChanged: (status, node) => console.log(`e2e: relay ${status}${node ? ` via ${node}` : ""}`),
    baseUrl: relayBaseUrl,
  });
  relay.start();
}

/** The desktop app's message; a malformed one changes nothing. */
function configureE2E(message: Record<string, unknown>): void {
  const config = parseE2EMessage(message);
  if (!config) return void console.warn("e2e: ignored a malformed configuration");
  e2e.setKey(config.transportKey);
  applyRelay(config.relay);
}

/** A removal closes the device's sessions with an authenticated GoAway(3) first; the relay drops a session whose
 * admission leaves the set at once (4404), so the smaller set follows a moment later. */
const ADMISSION_SETTLE_MS = 300;
devices.onChange(() => setTimeout(() => relay?.refreshAdmission(), ADMISSION_SETTLE_MS).unref());
e2e.onAdmissionChange(() => relay?.refreshAdmission());
devices.onDropped((deviceId) => {
  e2e.closeDevice(deviceId);
  console.log("companion: dropped a paired device its phone never used");
});

const control = createControlServer({
  devices,
  moves,
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
    e2e.closeDevice(deviceId);
    if (parentPort && !mutationToken) return;
    void notifyDeviceRevoked({ harnessPort: HARNESS_PORT, deviceId, mutationToken: mutationToken ?? undefined });
  },
  refreshTailscale: () => refreshTailnetName(),
  e2e: () => ({ enabled: e2e.enabled, relay: relay?.status ?? "off", node: relay?.node ?? null, descriptor: e2e.descriptor(null) }),
  liveRoutes: () => e2e.routes(),
  // The phone hears where it may connect from inside its session first. Narrowed, the relay keeps it a moment so that
  // lands, then refuses it (4404) and its relay sessions close; direct ones stay. Widened, it is admitted before it hears.
  routesChanged: (deviceId, routes) => {
    if (routes === "any") {
      relay?.refreshAdmission();
      proxy.sendEndpoints(deviceId);
      return;
    }
    const held = e2e.holdAdmission(deviceId, ADMISSION_SETTLE_MS);
    proxy.sendEndpoints(deviceId);
    void held.then(() => e2e.closeDevice(deviceId, CLOSE.normal, "relay"));
  },
  setRelay: (body) => {
    const config = parseRelayConfig(body);
    if (config === "invalid" || !e2e.enabled) return false;
    applyRelay(config);
    return true;
  },
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
  // Standing alone, end-to-end is opt-in and keeps its own key; the desktop app sends its key over its port.
  if (!parentPort && process.env.OMB_COMPANION_E2E === "1") {
    const key = standaloneTransportKey();
    e2e.setKey(key);
    console.log(`e2e: on, transport key ${b64u(key.publicKey).slice(0, 8)}…`);
  }
  await listen(control, CONTROL_PORT, "127.0.0.1");
  await listen(companion, COMPANION_PORT, "0.0.0.0");
  if (managedOrigin && PRIVATE_ORIGIN) {
    await listenCompanionOrigin(managedOrigin, PRIVATE_ORIGIN);
  }

  // Before advertising, so the first record already carries the name; a later rename withdraws the old one.
  await refreshMachineName();

  const tailscaleTried: string[] = [];
  await refreshTailnetName((cli, outcome) => tailscaleTried.push(`  ${cli} — ${outcome}`)).catch(() => {});

  // Through the watcher: a laptop may have no addresses yet, and they change
  // under a running sidecar. Discovery failing is never fatal.
  if (process.env.OMB_COMPANION_BONJOUR !== "0") {
    await watcher.check();
    watcher.start();
  }
  // A rename in Settings reaches the phone within one tick: the watcher re-advertises when the name moves.
  nameTimer = setInterval(() => void refreshMachineName().then((changed) => (changed && !stopping ? watcher.check() : undefined)), 30_000);
  nameTimer.unref?.();

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
  // The watcher first, or a tick (or a name refresh already in flight) could re-advertise the withdrawn record.
  stopping = true;
  watcher.stop();
  if (nameTimer) clearInterval(nameTimer);
  await mdns.stop().catch(() => {});
  // close() waits for open connections, and an SSE stream never ends on its own.
  relay?.stop();
  e2e.closeAll();
  e2eOrigin.close();
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
