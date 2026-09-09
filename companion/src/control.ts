// The bit a person looks at: a small page on loopback for pairing a device
// and revoking one.
//
// This replaces the Settings → Companion panel that used to live inside the
// desktop app. Losing that panel is the real cost of moving out of the
// harness, and this is the honest replacement rather than a pretence that
// the cost is zero: it is a separate page at a separate address, and you
// have to know it exists.
//
// Loopback only, deliberately and non-negotiably. This surface can open a
// pairing window and revoke devices — it is the thing the companion listener
// refuses to expose to phones for exactly that reason. Serving it anywhere
// else would hand away the control plane the design just took care to
// withhold.
import { createServer, type Server, type ServerResponse } from "node:http";

import type { DeviceRegistry } from "./devices.ts";
import { companionEndpointCandidates, hostedCompanionUrl } from "./endpoints.ts";
import { lanAddresses, tailnetName, tailscaleAddress } from "./listener.ts";
import { defaultHostName } from "./mdns.ts";

/** What the pairing page needs to render itself and act on what you click. */
export interface ControlOptions {
  devices: DeviceRegistry;
  /** Where a phone connects — for display, and for the pairing instructions. */
  companionPort: number;
  /** HPKE recipient public key displayed in pairing QRs. Public by design;
   * the matching private key never leaves Electron's encrypted store and
   * private utility-process channel. */
  secretPublicKey?: () => string | null;
  /** Stable HTTPS route provisioned for this computer, when available. */
  hostedUrl?: () => string | null;
  /** Electron alone uses this to publish a route after its connector health
   * check succeeds, and to withdraw it immediately on connector loss. */
  setHostedUrl?: (url: string | null) => void;
  /** Whether Bonjour came up, and under what name. */
  discovery: () => { advertising: boolean; name: string };
  /** Device ids with at least one live authenticated event stream. */
  connectedDeviceIds?: () => string[];
  /** Terminate every authenticated event stream and viewer relay session
   * owned by a device whose access changed or was revoked. */
  disconnectDevice?: (deviceId: string) => void;
  /** Re-read Tailscale after the sidecar has started. People commonly install,
   * sign in, or enable Tailscale while OpenMausBot is already running. */
  refreshTailscale?: () => Promise<void>;
}

/** The host out of a `Host` header, port removed.
 *
 * A bracketed IPv6 literal has colons of its own, so the obvious
 * `split(":")[0]` turns `[::1]:8811` into `[` — which matches no allowlist,
 * and refuses the loopback the browser was handed. A malformed authority
 * comes back unchanged rather than empty, so it fails the check instead of
 * skipping it. */
export function hostOf(authority: string): string {
  if (!authority.startsWith("[")) return authority.split(":")[0].toLowerCase();
  const end = authority.indexOf("]");
  // Only a port may follow the bracket. Without that check `[::1].evil.example`
  // unwraps to `::1` and passes the loopback allowlist — the parser would be
  // the hole rather than the fix.
  const rest = end > 1 ? authority.slice(end + 1) : "";
  const bracketed = end > 1 && (rest === "" || /^:\d+$/.test(rest));
  return (bracketed ? authority.slice(1, end) : authority).toLowerCase();
}

/** The only authorities this server answers to. `[::1]` is in the set as
 * well as `::1` because `new URL()` keeps the brackets on an IPv6 hostname
 * where `hostOf` strips them, and both spellings mean loopback. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Is this `Origin` one this server could plausibly have served itself?
 *
 * Absent counts as yes: a non-browser client — the desktop app, curl, the
 * phone's own app — sends no Origin at all, and those are exactly the callers
 * a CSRF check is not aimed at. Everything else must parse to a loopback
 * hostname. An opaque origin, which is what a sandboxed iframe or a `file://`
 * page sends, arrives as the literal string "null" and does not parse: that is
 * not a pass, it is precisely the shape an attacker reaches for, so it fails
 * with everything else foreign. Parsing rather than prefix-matching is what
 * refuses `https://127.0.0.1.evil.example`, which is not loopback at all.
 *
 * This is the floor, not the whole rule — see the caller, which additionally
 * requires the origin to be *this* server's, not merely some loopback one.
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Send a JSON body with its length, the only response shape this API has. */
const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

interface HostedEndpointPayload {
  url: string | null;
}

/** The control socket is also used by the packaged Electron app, where the
 * sidecar runs directly from its compiled output without a node_modules tree.
 * Keep this tiny wire contract dependency-free and deliberately exact: one
 * own enumerable `url` property, with no silently discarded extras. */
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

const currentHostedUrl = (options: ControlOptions): string | null =>
  options.hostedUrl?.() ?? null;

/** Every host a phone could dial for this computer, best first.
 *
 * One address is one point of failure: a phone paired over the tailnet keeps
 * a MagicDNS name that stops resolving the moment either device leaves the
 * tailnet — while the same computer sits reachable on the LAN. Handing the
 * phone the whole ordered list at pairing time is what lets it walk to the
 * next candidate instead of failing forever on the first.
 *
 * The order is the reachability story: the MagicDNS name works from anywhere
 * the tailnet does, the LAN addresses work on this network, and the sidecar's
 * synthetic mDNS name comes last because it only resolves while the sidecar
 * itself is running. The bare tailnet address is deliberately absent — iOS
 * refuses plain HTTP to 100.64/10, so it would be a candidate that can never
 * succeed. */
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

/** Everything the page shows, in one object: where to connect, whether a
 * pairing window is open, and which phones are paired. Recomputed per request
 * rather than cached — addresses change when you join another network. */
export function companionState(options: ControlOptions) {
  const addresses = lanAddresses();
  const tailscale = tailscaleAddress(addresses);
  const name = tailnetName();
  const pairing = options.devices.pairing();
  const secretPublicKey = options.secretPublicKey?.() ?? null;
  return {
    // Whoever starts this sidecar as a child process needs to be able to tell
    // it apart from an unrelated one that got to the control port first. An
    // answer on the port proves something is listening, not that it is ours.
    pid: process.pid,
    port: options.companionPort,
    addresses,
    ...(tailscale ? { tailscale } : {}),
    ...(tailscale && name ? { tailnetName: name } : {}),
    lan: addresses.find((a) => a !== tailscale) ?? null,
    // The ordered fallback list the pairing QR hands the phone, so it can
    // walk to the next address when the first stops resolving.
    hosts: hostCandidates(addresses, name),
    // Complete URLs for new clients. Unlike `hosts`, this can represent an
    // HTTPS route on its natural port without teaching the client to guess.
    endpoints: companionEndpointCandidates(
      options.companionPort,
      addresses,
      name,
      currentHostedUrl(options),
    ),
    ...(secretPublicKey ? { secretPublicKey } : {}),
    pairing: pairing ? { code: pairing.code, token: pairing.token, expiresAt: pairing.expiresAt } : null,
    devices: options.devices.list(),
    connectedDeviceIds: options.connectedDeviceIds?.() ?? [],
    discovery: options.discovery(),
  };
}

/** The loopback control plane: the page, its state, and the two writes —
 * open a pairing window, revoke a device. Bound to 127.0.0.1 by the caller,
 * and it refuses anything suggesting it was reached from anywhere else. */
export function createControlServer(options: ControlOptions): Server {
  return createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = requestUrl.pathname;
    const method = req.method ?? "GET";

    // Belt and braces: this server binds 127.0.0.1, so a non-loopback Host
    // should be impossible. It is still worth refusing, because "impossible"
    // here rests on a bind argument three files away, and the cost of being
    // wrong is the control plane.
    // An *absent* Host is HTTP/1.0, which has nothing to check and predates
    // the attack. A Host that is present is checked, and that includes one
    // that parses to nothing: a bare `::1` or a lone `:8811` is not a valid
    // authority, and the previous `host && …` guard waved both through for
    // exactly the reason they should have been refused — the parser could
    // make no sense of them, so it declined to have an opinion. Anything
    // unrecognised is refused now, which is the only safe direction for a
    // check whose job is to say no.
    const authority = String(req.headers.host ?? "");
    const host = hostOf(authority);
    if (authority && !LOOPBACK_HOSTS.has(host)) {
      return json(res, 403, { error: "forbidden: loopback only" });
    }

    // The Host check above stops DNS rebinding. It does not stop a page the
    // user happens to be reading from posting here directly: 127.0.0.1 is a
    // real address to a browser, a form POST or a simple fetch to it carries
    // a perfectly correct Host, and neither is preflighted — so CORS never
    // gets a say. That page cannot read the reply, but it does not need to.
    // `POST /pairing` opens a pairing window, and `DELETE /devices/:id`
    // revokes a phone; both do their damage on the way in.
    //
    // Origin is what separates the two callers, and it is the one header page
    // script cannot forge. The page below is served from this server and its
    // writes carry this server's origin, so an origin that both parses to
    // loopback and matches Host — already proven loopback — admits it and
    // nothing else: not a loopback page on some other port, not an opaque
    // "null" origin, not a hostname that merely begins with `127.0.0.1`. Not a
    // blanket refusal, which is what the device proxy can afford: there no
    // legitimate client is a browser at all, and here exactly one is.
    //
    // Safe methods are checked too. Nothing legitimate reads this API
    // cross-origin either, and a check that has to decide which methods
    // change state is a check with a list to keep up to date.
    const origin = req.headers.origin;
    if (origin && !(originIsLoopback(origin) && origin === `http://${authority}`)) {
      return json(res, 403, { error: "forbidden: cross-origin request" });
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      const html = page();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
      return res.end(html);
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
      // Keep the freshly issued credentials at the top level as well as in
      // `pairing`, matching the existing code response and making this write
      // sufficient for native control clients that do not immediately poll.
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
    const revoke = path.match(/^\/devices\/([\w-]+)$/);
    if (revoke && method === "DELETE") {
      if (!options.devices.revoke(revoke[1])) return json(res, 404, { error: "no such device" });
      options.disconnectDevice?.(revoke[1]);
      return json(res, 200, companionState(options));
    }
    return json(res, 404, { error: `no route: ${method} ${path}` });
  });
}

/** One self-contained page. No build step and no assets on purpose — a
 * sidecar that needed bundling would be a much bigger thing to run. */
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

/** Call the control API and return the state it answers with. */
async function api(path, method) {
  const res = await fetch(path, { method: method ?? "GET" });
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
          (d.cloudDesktopAccess ? "Cloud desktop on" : "Allow cloud desktop") + "</button></div>" +
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
