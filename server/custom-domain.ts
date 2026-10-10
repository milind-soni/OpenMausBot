import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { networkInterfaces } from "node:os";

const CHECK_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 16_384;
const DESCRIPTOR_PATH = "/.well-known/openmausbot/environment";
export const CUSTOM_DOMAIN_CHALLENGE_PATH = "/.well-known/openmausbot/domain-check/";

export class CustomDomainError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CustomDomainError";
    this.status = status;
  }
}

/** A public domain on standard HTTPS, never an invitation or arbitrary URL. */
export function normalizeCustomDomain(raw: string): string {
  const value = raw.trim();
  // Reject characters URL parsing otherwise removes or interprets as secrets.
  // eslint-disable-next-line no-control-regex
  if (!value || value.length > 512 || /[\s\u0000-\u001f\u007f\\?#@%]/.test(value)) {
    throw new CustomDomainError("Enter a domain such as bots.yourcompany.com, without a path, password, or pairing code.");
  }
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.port || url.pathname !== "/" || url.username || url.password
      || isIP(host) || host.startsWith("[") || host.length > 253 || !host.includes(".")
      || !host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
      || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)) throw new Error("invalid origin");
    return `https://${host}`;
  } catch {
    throw new CustomDomainError("Use a public domain with HTTPS on port 443, without a path or pairing code.");
  }
}

const excludedAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) excludedAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) excludedAddresses.addSubnet(address, prefix, "ipv6");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");

/** Exclude private, mapped/NAT64, multicast, documentation, and reserved ranges. */
export function isPublicDomainAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !excludedAddresses.check(address, "ipv4");
  return family === 6 && globalIpv6.check(address, "ipv6") && !excludedAddresses.check(address, "ipv6");
}

/** Local interfaces only: a tunnel/CDN address or an external IP-echo service
 * does not identify the server where the customer's HTTPS proxy runs. */
export function customDomainIpv4(
  interfaces = networkInterfaces(),
  configured = process.env.OMB_PUBLIC_IPV4,
): string | null {
  if (configured?.trim()) {
    const address = configured.trim();
    return isIP(address) === 4 && isPublicDomainAddress(address) ? address : null;
  }
  const addresses = new Set(Object.values(interfaces).flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && entry.family === "IPv4" && isPublicDomainAddress(entry.address))
    .map((entry) => entry.address));
  // Containers/NAT and multi-address hosts need an explicit operator choice.
  return addresses.size === 1 ? [...addresses][0]! : null;
}

interface CustomDomainDependencies {
  environmentId: string;
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  request?: (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CustomDomainError("The domain check timed out. Check DNS, HTTPS, and your reverse proxy, then try again."));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function requestJson(url: URL, address: LookupAddress, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Pin the validated DNS result for both requests. TLS/SNI and Host still use
    // the original domain, so a DNS rebind cannot reach a private IP afterwards.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
    const request = httpsRequest(url, {
      method: "GET", agent: false, lookup, signal, rejectUnauthorized: true,
      headers: { Accept: "application/json", "User-Agent": "OpenMausBot-domain-check" },
    }, (response) => {
      // Node's HTTPS client does not follow Location redirects.
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new CustomDomainError("The domain did not return the OpenMausBot verification page. Check your reverse proxy; redirects are not supported."));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy();
          reject(new CustomDomainError("The domain returned an unexpected response. Check that it points to OpenMausBot."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new CustomDomainError("The domain did not return OpenMausBot data. Check that it points to this server.")); }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

/** Verification only: callers persist the returned origin after success. The
 * public challenge endpoint reveals no account credentials and grants no access. */
export function createCustomDomainVerifier(dependencies: CustomDomainDependencies) {
  const lookup = dependencies.lookup ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  const request = dependencies.request ?? requestJson;
  let inFlight = false;
  let active: { token: string; proof: string; expiresAt: number } | null = null;

  return {
    challenge(token: string): { environmentId: string; proof: string } | null {
      if (!active || Date.now() >= active.expiresAt || token !== active.token) return null;
      return { environmentId: dependencies.environmentId, proof: active.proof };
    },
    async verify(raw: string): Promise<{ origin: string; verifiedAt: string }> {
      const origin = normalizeCustomDomain(raw);
      if (inFlight) throw new CustomDomainError("A domain check is already running. Wait for it to finish, then try again.", 409);
      inFlight = true;
      const controller = new AbortController();
      const timeoutMs = dependencies.timeoutMs ?? CHECK_TIMEOUT_MS;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let addresses: LookupAddress[];
        try {
          addresses = await withAbort(lookup(new URL(origin).hostname), controller.signal);
        } catch (error) {
          if (error instanceof CustomDomainError) throw error;
          throw new CustomDomainError("The domain could not be found in DNS. Add its A or AAAA record and allow time for it to become available.");
        }
        if (!addresses.length || addresses.some((entry) => !isPublicDomainAddress(entry.address)
          || isIP(entry.address) !== entry.family)) {
          throw new CustomDomainError("The domain must resolve only to public internet addresses. Local, private, and reserved addresses cannot be connected here.");
        }
        // Prefer IPv4 where both exist; use the exact same address for proof.
        const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
        const descriptor = await withAbort(request(new URL(DESCRIPTOR_PATH, origin), address, controller.signal), controller.signal);
        if (!descriptor || typeof descriptor !== "object"
          || Reflect.get(descriptor, "environmentId") !== dependencies.environmentId) {
          throw new CustomDomainError("This domain does not point to this OpenMausBot server. Check its DNS and reverse proxy configuration.");
        }
        active = {
          token: randomBytes(32).toString("hex"), proof: randomBytes(32).toString("hex"),
          expiresAt: Date.now() + timeoutMs,
        };
        const proof = await withAbort(request(new URL(`${CUSTOM_DOMAIN_CHALLENGE_PATH}${active.token}`, origin), address, controller.signal), controller.signal);
        if (!proof || typeof proof !== "object" || Reflect.get(proof, "environmentId") !== dependencies.environmentId
          || Reflect.get(proof, "proof") !== active.proof) {
          throw new CustomDomainError("The domain could not prove it reaches this server. Forward all OpenMausBot routes through your reverse proxy and try again.");
        }
        return { origin, verifiedAt: new Date().toISOString() };
      } catch (error) {
        if (error instanceof CustomDomainError) throw error;
        throw new CustomDomainError("A secure connection to the domain could not be verified. Check its HTTPS certificate, firewall, and reverse proxy.");
      } finally {
        clearTimeout(timer);
        controller.abort();
        active = null;
        inFlight = false;
      }
    },
  };
}
