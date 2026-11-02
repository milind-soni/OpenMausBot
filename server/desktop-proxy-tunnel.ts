import type { Socket } from "node:net";
import { openProxyTunnel } from "../electron/proxy-transport.mjs";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { once } from "node:events";

export async function openDesktopProxyTunnel(target: { host: string; port: number; url?: string }, addresses: readonly { address: string }[]): Promise<Socket> {
  const endpoint = process.env.OMB_DESKTOP_PROXY;
  if (!endpoint) throw new Error("Desktop proxy is unavailable");
  for (const address of addresses) {
    try {
      return await openProxyTunnel({ hostname: target.host, port: String(target.port), address: address.address, url: target.url }, new URL(endpoint));
    } catch {}
  }
  throw new Error("Desktop proxy connection failed");
}

export async function desktopRequestAgent(url: URL, addresses: readonly { address: string }[]): Promise<HttpAgent | HttpsAgent | false> {
  if (!process.env.OMB_DESKTOP_PROXY) return false;
  let socket = await openDesktopProxyTunnel({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), url: url.href }, addresses);
  const secure = url.protocol === "https:";
  if (secure) {
    const tls = tlsConnect({ socket, servername: url.hostname });
    tls.setTimeout(10_000, () => tls.destroy(new Error("TLS handshake timed out")));
    tls.resume();
    try { await once(tls, "secureConnect"); } catch (error) { tls.destroy(); throw error; }
    tls.setTimeout(0);
    socket = tls;
  }
  const agent = secure ? new HttpsAgent() : new HttpAgent();
  agent.createConnection = () => socket;
  return agent;
}
