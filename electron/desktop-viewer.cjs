// URL boundary for the in-app desktop viewer. Cloud viewers must use HTTPS;
// the HTTP exceptions are desktops on this machine: the passworded noVNC
// server and Cua Spaces' Linux viewers bound to loopback, and a macOS Cua
// Space's viewer on the Mac's own Virtualization NAT bridge (bridge100+,
// 192.168.64.0/24 by default). Mirrors onThisMachine in
// server/cua-spaces-computer.ts, which vets the same links before handing
// them to the renderer.

const { networkInterfaces } = require("node:os");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function ipv4(address) {
  const parts = String(address).split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts.reduce((value, part) => value * 256 + part, 0)
    : null;
}

/** A guest on one of this Mac's Virtualization NAT bridges. A LAN interface,
 * or bridge0 (the Thunderbolt bridge to another machine), never qualifies. */
function onVirtualMachineBridge(hostname, interfaces) {
  const host = ipv4(hostname);
  if (host === null) return false;
  return Object.entries(interfaces).some(([name, addresses]) => /^bridge1\d\d$/.test(name)
    && (addresses ?? []).some((entry) => {
      const address = entry.family === "IPv4" ? ipv4(entry.address) : null;
      const mask = ipv4(entry.netmask);
      return address !== null && mask !== null && (address & mask) >>> 0 === (host & mask) >>> 0;
    }));
}

function desktopViewerUrl(rawUrl, interfaces = networkInterfaces(), platform = process.platform) {
  if (Object.prototype.toString.call(rawUrl) !== "[object String]" || !rawUrl.trim()) {
    throw new Error("A desktop viewer address is required");
  }
  if (rawUrl.length > 16_384) throw new Error("The desktop viewer address is too long");

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The desktop viewer address is invalid");
  }

  const localHttp = url.protocol === "http:"
    && (LOOPBACK_HOSTS.has(url.hostname) || (platform === "darwin" && onVirtualMachineBridge(url.hostname, interfaces)));
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("The desktop viewer must use HTTPS or the local VM address");
  }
  if (url.username || url.password) {
    throw new Error("Desktop viewer credentials must not use URL user info");
  }
  return url;
}

function sameDesktopViewerOrigin(rawUrl, origin) {
  try {
    return desktopViewerUrl(rawUrl).origin === origin;
  } catch {
    return false;
  }
}

module.exports = { desktopViewerUrl, sameDesktopViewerOrigin };
