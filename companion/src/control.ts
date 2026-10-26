// A loopback-only page for pairing and revoking devices. Never serve it
// anywhere else: it is the control plane the companion listener withholds
// from phones. Every route but the page itself needs the per-launch control
// token, which only the launching app and the link the sidecar prints carry.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

import type { DeviceRegistry } from "./devices.ts";
import { companionEndpointCandidates, hostedCompanionUrl } from "./endpoints.ts";
import { lanAddresses, lanInterfaces, tailnetName, tailscaleAddress } from "./listener.ts";
import { defaultHostName } from "./mdns.ts";
import { publicNetworks } from "./windows-network.ts";

export const CONTROL_TOKEN_HEADER = "x-openmausbot-control-token";

export interface ControlOptions {
  devices: DeviceRegistry;
  /** Null until the launching app has sent it: every route but the page answers 403. */
  controlToken: () => string | null;
  companionPort: number;
  /** HPKE recipient public key shown in pairing QRs; the private key never
   * leaves Electron's encrypted store. */
  secretPublicKey?: () => string | null;
  hostedUrl?: () => string | null;
  /** Electron publishes a route after its connector health check succeeds
   * and withdraws it on connector loss. */
  setHostedUrl?: (url: string | null) => void;
  discovery: () => { advertising: boolean; name: string };
  connectedDeviceIds?: () => string[];
  /** Terminate every event stream and viewer relay session a device owns. */
  disconnectDevice?: (deviceId: string) => void;
  /** Revoked, not merely changed: the harness ends the Live call that phone holds. */
  revoked?: (deviceId: string) => void;
  refreshTailscale?: () => Promise<void>;
  publicNetworks?: () => ReadonlySet<string>;
}

/** A bracketed IPv6 literal has colons of its own. A malformed authority comes
 * back unchanged, so it fails the allowlist instead of skipping it. */
export function hostOf(authority: string): string {
  if (!authority.startsWith("[")) return authority.split(":")[0].toLowerCase();
  const end = authority.indexOf("]");
  // Only a port may follow the bracket, or `[::1].evil.example` unwraps to `::1`.
  const rest = end > 1 ? authority.slice(end + 1) : "";
  const bracketed = end > 1 && (rest === "" || /^:\d+$/.test(rest));
  return (bracketed ? authority.slice(1, end) : authority).toLowerCase();
}

/** `[::1]` too: `new URL()` keeps the brackets on an IPv6 hostname. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Absent counts as yes: non-browser clients send no Origin. An opaque "null"
 * origin fails, and parsing (not prefix-matching) refuses
 * `https://127.0.0.1.evil.example`. The caller also requires this server's own
 * origin. */
export function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Null when the desktop app launched this sidecar: it sends the token over its private port, and the control port
 * opens only then. Standing alone, the token is OMB_CONTROL_TOKEN when a script chose one, else random. */
export function initialControlToken(env: NodeJS.ProcessEnv, launchedByApp: boolean): string | null {
  if (launchedByApp) return null;
  const chosen = env.OMB_CONTROL_TOKEN ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(chosen) ? chosen : randomBytes(32).toString("base64url");
}

function tokenMatches(presented: string | string[] | undefined, expected: string | null): boolean {
  if (!expected || typeof presented !== "string") return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

interface HostedEndpointPayload {
  url: string | null;
}

/** Dependency-free (the packaged sidecar has no node_modules) and exact: one
 * own enumerable `url` property, no extras. */
const isHostedEndpointPayload = (value: unknown): value is HostedEndpointPayload => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "url") return false;
  const url = (value as { url?: unknown }).url;
  return url === null || typeof url === "string";
};

const readHostedEndpoint = (
  req: import("node:http").IncomingMessage,
): Promise<HostedEndpointPayload> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!isHostedEndpointPayload(parsed)) throw new Error("invalid shape");
        resolve(parsed);
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
  });

const currentHostedUrl = (options: Pick<ControlOptions, "hostedUrl">): string | null =>
  options.hostedUrl?.() ?? null;

/** Best first: the MagicDNS name, the LAN addresses, then the sidecar's mDNS
 * name, which resolves only while it runs. The bare tailnet address is absent:
 * iOS refuses plain HTTP to 100.64/10. */
export function hostCandidates(
  addresses: string[] = lanAddresses(),
  magicDnsName: string | null = tailnetName(),
): string[] {
  const tailscale = tailscaleAddress(addresses);
  const out: string[] = [];
  if (tailscale && magicDnsName) out.push(magicDnsName);
  for (const address of addresses) {
    if (address !== tailscale) out.push(address);
  }
  out.push(defaultHostName());
  return out;
}

/** Recomputed per request: addresses change when you join another network. */
export function companionState(options: Omit<ControlOptions, "controlToken">) {
  const interfaces = lanInterfaces();
  const addresses = interfaces.map((entry) => entry.address);
  const tailscale = tailscaleAddress(addresses);
  const lead = interfaces.find((entry) => entry.address !== tailscale) ?? null;
  const name = tailnetName();
  const pairing = options.devices.pairing();
  // Asked only while pairing is open: on Windows the answer is a PowerShell process.
  const publicNetwork = pairing && lead && (options.publicNetworks ?? publicNetworks)().has(lead.name)
    ? lead.name
    : null;
  const secretPublicKey = options.secretPublicKey?.() ?? null;
  return {
    // Lets a parent tell this sidecar from an unrelated process on the control port.
    pid: process.pid,
    port: options.companionPort,
    addresses,
    ...(tailscale ? { tailscale } : {}),
    ...(tailscale && name ? { tailnetName: name } : {}),
    lan: lead?.address ?? null,
    // Windows has this network as Public, so its firewall likely drops a phone.
    ...(publicNetwork ? { publicNetwork } : {}),
    hosts: hostCandidates(addresses, name),
    endpoints: companionEndpointCandidates(
      options.companionPort,
      addresses,
      name,
      currentHostedUrl(options),
    ),
    ...(secretPublicKey ? { secretPublicKey } : {}),
    pairing: pairing ? { code: pairing.code, token: pairing.token, expiresAt: pairing.expiresAt } : null,
    devices: options.devices.list(),
    // An empty list from an unreadable file must not read as "nothing paired".
    ...(options.devices.devicesUnreadable() ? { devicesUnreadable: true } : {}),
    connectedDeviceIds: options.connectedDeviceIds?.() ?? [],
    discovery: options.discovery(),
  };
}

export function createControlServer(options: ControlOptions): Server {
  return createServer((req, res) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      return json(res, 400, { error: "invalid request target" });
    }
    const path = requestUrl.pathname;
    const method = req.method ?? "GET";

    // The bind already makes a non-loopback Host impossible; refused anyway. An
    // absent Host (HTTP/1.0) passes; a present one that parses to nothing fails.
    const authority = String(req.headers.host ?? "");
    const host = hostOf(authority);
    if (authority && !LOOPBACK_HOSTS.has(host)) {
      return json(res, 403, { error: "forbidden: loopback only" });
    }

    // Host stops DNS rebinding, not a page posting here unpreflighted. Only an
    // origin that parses to loopback and matches Host passes, for every method.
    const origin = req.headers.origin;
    if (origin && !(originIsLoopback(origin) && origin === `http://${authority}`)) {
      return json(res, 403, { error: "forbidden: cross-origin request" });
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      const html = page();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
      return res.end(html);
    }
    if (!tokenMatches(req.headers[CONTROL_TOKEN_HEADER], options.controlToken())) {
      return json(res, 403, { error: "forbidden: open the companion's control page from the link it printed" });
    }
    if (method === "GET" && path === "/state") return json(res, 200, companionState(options));
    if (method === "POST" && path === "/tailscale/refresh" && options.refreshTailscale) {
      void options.refreshTailscale().then(
        () => json(res, 200, companionState(options)),
        () => json(res, 500, { error: "could not refresh Tailscale" }),
      );
      return;
    }
    if (method === "POST" && path === "/pairing") {
      const window = options.devices.openPairing();
      // Credentials at the top level too, for native clients that do not poll.
      return json(res, 201, {
        ...companionState(options),
        code: window.code,
        token: window.token,
      });
    }
    if (method === "DELETE" && path === "/pairing") {
      const expectedToken = requestUrl.searchParams.get("expectedToken") ?? undefined;
      options.devices.closePairing(expectedToken);
      return json(res, 200, companionState(options));
    }
    const updateHostedUrl = options.setHostedUrl;
    if (method === "PUT" && path === "/hosted-endpoint" && updateHostedUrl) {
      readHostedEndpoint(req).then(
        (body) => {
          try {
            const requested = body.url == null || body.url === "" ? null : hostedCompanionUrl(body.url);
            updateHostedUrl(requested);
            return json(res, 200, companionState(options));
          } catch {
            return json(res, 400, { error: "invalid hosted endpoint" });
          }
        },
        (error: Error) => json(res, 400, { error: error.message }),
      );
      return;
    }
    const cloudDesktop = path.match(/^\/devices\/([\w-]+)\/cloud-desktop$/);
    if (cloudDesktop && (method === "POST" || method === "DELETE")) {
      try {
        if (!options.devices.setCloudDesktopAccess(cloudDesktop[1], method === "POST")) {
          return json(res, 404, { error: "no such device" });
        }
      } catch {
        return json(res, 500, { error: "could not save cloud desktop access" });
      }
      options.disconnectDevice?.(cloudDesktop[1]);
      return json(res, 200, companionState(options));
    }
    const browserControl = path.match(/^\/devices\/([\w-]+)\/browser-control$/);
    if (browserControl && (method === "POST" || method === "DELETE")) {
      try {
        if (!options.devices.setBrowserControlAccess(browserControl[1], method === "POST")) {
          return json(res, 404, { error: "no such device" });
        }
      } catch {
        return json(res, 500, { error: "could not save browser control access" });
      }
      // Revoking must reach the streams this device already holds open.
      options.disconnectDevice?.(browserControl[1]);
      return json(res, 200, companionState(options));
    }
    const revoke = path.match(/^\/devices\/([\w-]+)$/);
    if (revoke && method === "DELETE") {
      try {
        if (!options.devices.revoke(revoke[1])) return json(res, 404, { error: "no such device" });
      } catch {
        return json(res, 500, { error: "could not save the device removal" });
      }
      options.disconnectDevice?.(revoke[1]);
      options.revoked?.(revoke[1]);
      return json(res, 200, companionState(options));
    }
    return json(res, 404, { error: `no route: ${method} ${path}` });
  });
}

function page(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenMausBot Companion</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --dim: #666; --line: #0002; --bg: #fff; --card: #fafafa; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #eee; --dim: #999; --line: #fff2; --bg: #151515; --card: #1e1e1e; }
  }
  body { font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; color: var(--fg); background: var(--bg);
         margin: 0; padding: 2.5rem 1.25rem; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .35rem; }
  p.sub { color: var(--dim); margin: 0 0 1.75rem; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
            padding: 1rem 1.15rem; margin-bottom: 1rem; }
  h2 { font-size: .95rem; margin: 0 0 .5rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .code { font: 600 2rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .3em; }
  .dim { color: var(--dim); }
  button { font: inherit; padding: .4rem .8rem; border-radius: 8px; border: 1px solid var(--line);
           background: transparent; color: inherit; cursor: pointer; }
  button:hover { background: var(--line); }
  ul { list-style: none; padding: 0; margin: .5rem 0 0; }
  li { display: flex; align-items: center; gap: .75rem; padding: .5rem 0; border-top: 1px solid var(--line); }
  li .grow { flex: 1; min-width: 0; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
<main>
  <h1>OpenMausBot Companion</h1>
  <p class="sub">Your phone reaches this computer through here. Only pair a device you trust.</p>
  <section id="where"></section>
  <section id="pair"></section>
  <section id="devices"></section>
</main>
<script type="module">
/** Shorthand for the handful of nodes this page updates. */
const el = (id) => document.getElementById(id);
/** Escape before interpolating. Device names are user-supplied and end up in
 * innerHTML, which is the one place here that has to be airtight. */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** A timestamp as "3 minutes ago", for the paired-device list. */
const ago = (at) => {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
};

// The link the companion printed carries the control token in its fragment, which never leaves this page.
const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
history.replaceState(null, "", location.pathname);

/** Call the control API and return the state it answers with. */
async function api(path, method) {
  const res = await fetch(path, { method: method ?? "GET", headers: { "x-openmausbot-control-token": token } });
  if (res.status === 403) {
    document.querySelector("main").innerHTML = "<h1>OpenMausBot Companion</h1><p class=sub>Open this page from the link the companion printed when it started.</p>";
    throw new Error("control token required");
  }
  return res.json();
}

/** Redraw the whole page from one state object, listeners included. */
function render(s) {
  // The tailnet name beats the address: iOS refuses plain HTTP to 100.64/10,
  // which is CGNAT space rather than one of the ranges its local-networking
  // exemption covers, and ATS exceptions match by name rather than subnet.
  const reach = s.tailnetName ?? s.tailscale ?? s.addresses[0];
  el("where").innerHTML =
    "<h2>Where to connect</h2>" +
    (reach
      ? "<p>Enter <code>" + esc(reach) + ":" + s.port + "</code> on your phone." +
        (s.tailnetName ? " That works from any network." : "") + "</p>"
      : "<p class=dim>No network address yet.</p>") +
    (s.tailnetName && s.lan ? "<p class=dim>On this network only: <code>" + esc(s.lan) + ":" + s.port + "</code></p>" : "") +
    (s.tailscale && !s.tailnetName
      ? "<p class=dim>On a tailnet, but this computer's MagicDNS name could not be read from Tailscale — either MagicDNS is off, or its command line tool is not where we looked. iPhones cannot connect to a bare tailnet address; the console output lists what was tried.</p>"
      : "") +
    (!s.tailscale
      ? "<p class=dim>Reachable on this network only. Install Tailscale on both this computer and your phone to reach it from anywhere — including networks that stop devices from seeing each other.</p>"
      : "") +
    (s.discovery.advertising
      ? "<p class=dim>Your phone can also find this computer as \\u201c" + esc(s.discovery.name) + "\\u201d.</p>"
      : "");

  el("pair").innerHTML = s.pairing
    ? "<h2>Pair a phone</h2><div class=code>" + esc(s.pairing.code) + "</div>" +
      "<p class=dim>Expires in <span id=left></span>s. Enter it on your phone.</p>" +
      "<button id=cancel>Cancel</button>"
    : "<h2>Pair a phone</h2><p class=dim>The code lasts two minutes.</p><button id=start>Start pairing</button>";

  el("devices").innerHTML =
    "<h2>Paired devices</h2>" +
    (s.devices.length
      ? "<ul>" + s.devices.map((d) =>
          "<li><div class='grow'><div class=name>" + esc(d.name) + "</div>" +
          "<div class=dim>Last seen " + ago(d.lastSeenAt) + "</div>" +
          "<button data-cloud='" + esc(d.id) + "' data-allowed='" + (d.cloudDesktopAccess ? "1" : "0") + "'>" +
          (d.cloudDesktopAccess ? "Cloud desktop on" : "Allow cloud desktop") + "</button>" +
          "<button data-browser='" + esc(d.id) + "' data-browser-allowed='" + (d.browserControlAccess ? "1" : "0") + "'>" +
          (d.browserControlAccess ? "Browser control on" : "Allow browser control") + "</button></div>" +
          "<button data-revoke='" + esc(d.id) + "'>Remove</button></li>").join("") + "</ul>"
      : "<p class=dim>No phones are paired yet.</p>");

  el("start")?.addEventListener("click", async () => render(await api("/pairing", "POST")));
  el("cancel")?.addEventListener("click", async () => render(await api("/pairing", "DELETE")));
  for (const b of document.querySelectorAll("[data-revoke]")) {
    b.addEventListener("click", async () => render(await api("/devices/" + b.dataset.revoke, "DELETE")));
  }
  for (const b of document.querySelectorAll("[data-cloud]")) {
    b.addEventListener("click", async () => render(await api(
      "/devices/" + b.dataset.cloud + "/cloud-desktop",
      b.dataset.allowed === "1" ? "DELETE" : "POST"
    )));
  }
  for (const b of document.querySelectorAll("[data-browser]")) {
    b.addEventListener("click", async () => render(await api(
      "/devices/" + b.dataset.browser + "/browser-control",
      b.dataset.browserAllowed === "1" ? "DELETE" : "POST"
    )));
  }
  if (s.pairing) {
    const tick = () => {
      const left = Math.max(0, Math.round((s.pairing.expiresAt - Date.now()) / 1000));
      const node = el("left");
      if (node) node.textContent = left;
    };
    tick();
  }
}

render(await api("/state"));
// Two cadences, keyed to what the page is actually waiting for.
//
// While a code is on screen it has to count down, and the same tick is what
// notices the phone on the other end finishing the handshake — one second.
// With no pairing open there is nothing moving faster than the user, and a
// fixed one-second poll is a request every second for as long as the tab
// stays open, which on a page people leave sitting there is most of them.
//
// Self-scheduling rather than setInterval: a slow reply cannot stack up
// another poll behind it.
const poll = async () => {
  const s = await api("/state");
  render(s);
  setTimeout(poll, s.pairing ? 1000 : 10000);
};
setTimeout(poll, 1000);
</script>
`;
}
