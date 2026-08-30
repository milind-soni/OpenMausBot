// Pure helpers for the built-in browser surface. Nothing here touches
// Electron: the accessibility-tree → element-ref reduction, the navigation
// URL policy and the user-agent scrub are plain functions so they can be
// tested without a window. The ref format and role filter deliberately match
// the cloud box's CDP helper (server/remote-computer.ts) so a bot that learned
// browser_snapshot there reads the same shape here.
"use strict";

const { BlockList, isIP } = require("node:net");

/** Roles worth handing to a model as click/fill targets. Structural roles
 * (generic, group, paragraph) are noise; these are the interactive ones plus
 * headings, which anchor "click the link under Pricing" style instructions. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "heading",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

const MAX_SNAPSHOT_ELEMENTS = 250;
const MAX_NAME_LENGTH = 180;

// A browser driven by an agent is an SSRF surface unless local destinations
// are refused. Keep this list deliberately broader than RFC1918: link-local,
// carrier-grade NAT, benchmark/documentation ranges, multicast and IPv6
// local/mapped ranges must not become a door into services on the user's
// machine or LAN (including cloud instance metadata).
const PRIVATE_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) PRIVATE_IPV4.addSubnet(network, prefix, "ipv4");
const PRIVATE_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 96],
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8],
]) PRIVATE_IPV6.addSubnet(network, prefix, "ipv6");

const stripIpv6Brackets = (value) => String(value ?? "").replace(/^\[|\]$/g, "");

/** True only for a globally routable address. Unknown strings fail closed. */
function browserAddressAllowed(address) {
  const normalized = stripIpv6Brackets(address);
  const family = isIP(normalized);
  if (!family) return false;
  return family === 4
    ? !PRIVATE_IPV4.check(normalized, "ipv4")
    : !PRIVATE_IPV6.check(normalized, "ipv6");
}

function assertPublicBrowserHost(url) {
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase().replace(/\.$/, "");
  if (!hostname) throw new Error("That web address is invalid");
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname === "metadata.google.internal"
  ) {
    throw new Error("Local and private-network pages cannot be opened in the built-in browser");
  }
  if (isIP(hostname) && !browserAddressAllowed(hostname)) {
    throw new Error("Local and private-network pages cannot be opened in the built-in browser");
  }
}

/** Value of a CDP AXNode property by name, or undefined. */
function axProperty(node, name) {
  const property = Array.isArray(node?.properties)
    ? node.properties.find((candidate) => candidate?.name === name)
    : undefined;
  return property?.value?.value;
}

/**
 * Reduce a CDP `Accessibility.getFullAXTree` result to the elements a model
 * can act on. Refs are `b<backendDOMNodeId>`: stable for the life of the DOM
 * node, meaningless after the page changes — which is why every action
 * hands back a fresh snapshot.
 */
function snapshotFromAxNodes(nodes, { limit = MAX_SNAPSHOT_ELEMENTS } = {}) {
  const elements = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.ignored === true) continue;
    const role = String(node?.role?.value ?? "").toLowerCase();
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const backend = Number(node?.backendDOMNodeId ?? 0);
    if (!Number.isInteger(backend) || backend <= 0) continue;
    const editable = role === "textbox" || role === "searchbox" || role === "combobox" || role === "spinbutton";
    const rawName = String(node?.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
    if (!rawName && !editable) continue;
    // The bare AX tree cannot relate a heading/label contributor to the
    // protected field that consumed it, so *any* accessible name could carry
    // an OTP, API key, recovery phrase, etc. Preserve only the structural
    // role. The rich isolated-world snapshot keeps ordinary labels/values
    // after applying the full DOM classifier.
    const name = editable ? "protected field" : role;
    const element = { ref: `b${backend}`, role, name };
    if (axProperty(node, "disabled") === true) element.disabled = true;
    // CDP's bare AX tree does not reliably expose an input's HTML type. A
    // password field can therefore look exactly like an ordinary textbox.
    // The rich injected snapshot can safely retain non-secret values; this
    // fallback fails closed and never returns editable contents to a model.
    if (axProperty(node, "checked") !== undefined) element.checked = axProperty(node, "checked");
    elements.push(element);
    if (elements.length >= limit) break;
  }
  return elements;
}

/** One line per element, the shape the box helper's consumers already read. */
function formatSnapshot({ title, url, elements }) {
  const lines = (elements ?? []).map((element) => {
    const flags = [
      element.disabled ? "disabled" : "",
      element.checked === true ? "checked" : element.checked === "mixed" ? "mixed" : "",
      element.value !== undefined ? `value=${JSON.stringify(element.value)}` : "",
    ].filter(Boolean);
    return `${element.ref} ${element.role} ${JSON.stringify(element.name)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  });
  return `Browser snapshot — ${title || "Untitled"}: ${url || "about:blank"}\n${
    lines.join("\n") || "No interactive elements found."
  }`;
}

const NAVIGABLE_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * The only addresses the surface will load. Bots (and the address bar) may
 * omit the scheme; anything that is not web content — file://, chrome://,
 * javascript:, data: — is refused rather than opened in a privileged shell.
 */
function browserNavigationUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("A web address is required");
  if (text === "about:blank") return text;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error("That web address is invalid");
  }
  if (!NAVIGABLE_PROTOCOLS.has(url.protocol)) {
    throw new Error("Only http and https pages can be opened in the browser");
  }
  if (url.username || url.password) throw new Error("Credentials cannot be embedded in a browser address");
  assertPublicBrowserHost(url);
  return url.toString();
}

/** True when a navigation target is one the surface may follow. */
function browserNavigationAllowed(raw) {
  try {
    browserNavigationUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/** Sites vary behaviour on unfamiliar UA tokens; present as the Chrome that
 * Electron actually is. */
function browserUserAgent(userAgent) {
  return String(userAgent ?? "")
    .replace(/\s?OpenMausBot\/\S+/g, "")
    .replace(/\s?openmausbot\/\S+/g, "")
    .replace(/\s?Electron\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A bot id becomes a durable session partition: logins survive restarts
 * and no two bots share a cookie jar. Only the safe id characters are kept
 * so a hostile id cannot reach outside the partition namespace. */
function browserPartition(botId) {
  const safe = String(botId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) throw new Error("A bot id is required");
  return `persist:openmausbot-browser-${safe}`;
}

/** A named profile is a partition several bots may share — "Work", "Client
 * A" — so one sign-in serves every bot pointed at it. New profile ids are
 * lowercase, but #567 already persisted mixed-case partition identities.
 * Accept only that exact safe alphabet and never normalize it: normalization
 * could silently route a migrated profile into another account. */
function browserProfilePartition(partitionId) {
  const id = String(partitionId ?? "");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || id === "guest") {
    throw new Error("A valid browser profile partition id is required");
  }
  return `persist:openmausbot-browser-profile-${id}`;
}

const REF = /^b(\d{1,12})$/;

/** The backend DOM node id encoded in a snapshot ref. */
function backendNodeIdFromRef(ref) {
  const match = REF.exec(String(ref ?? "").trim());
  if (!match) throw new Error("invalid or stale browser ref; take a new browser_snapshot");
  return Number(match[1]);
}

module.exports = {
  INTERACTIVE_ROLES,
  MAX_SNAPSHOT_ELEMENTS,
  backendNodeIdFromRef,
  browserAddressAllowed,
  browserNavigationAllowed,
  browserNavigationUrl,
  browserPartition,
  browserProfilePartition,
  browserUserAgent,
  formatSnapshot,
  snapshotFromAxNodes,
};
