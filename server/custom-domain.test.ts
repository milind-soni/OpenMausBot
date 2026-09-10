import { EventEmitter } from "node:events";
import type { LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { NetworkInterfaceInfo } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { httpsRequestMock } = vi.hoisted(() => ({ httpsRequestMock: vi.fn() }));
vi.mock("node:https", () => ({ request: httpsRequestMock }));

import {
  CUSTOM_DOMAIN_CHALLENGE_PATH,
  createCustomDomainVerifier,
  customDomainIpv4,
  isPublicDomainAddress,
  normalizeCustomDomain,
} from "./custom-domain.ts";

const environmentId = "2cac4256-d238-49a4-bab5-227183911e55";
const publicAddress: LookupAddress = { address: "8.8.8.8", family: 4 };

function fixture(options: { addresses?: LookupAddress[]; timeoutMs?: number } = {}) {
  let verifier: ReturnType<typeof createCustomDomainVerifier>;
  const lookup = vi.fn(async () => options.addresses ?? [publicAddress]);
  const request = vi.fn(async (url: URL, _address: LookupAddress, _signal: AbortSignal): Promise<unknown> => {
    if (url.pathname.endsWith("/environment")) return { environmentId };
    return verifier.challenge(url.pathname.slice(CUSTOM_DOMAIN_CHALLENGE_PATH.length));
  });
  verifier = createCustomDomainVerifier({ environmentId, lookup, request, timeoutMs: options.timeoutMs });
  return { verifier, lookup, request };
}

afterEach(() => vi.useRealTimers());

describe("DNS record server address", () => {
  const interfaces = (...addresses: string[]) => ({ eth0: addresses.map((address): NetworkInterfaceInfo => ({
    address, family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null,
  })) });

  it("shows a single public IPv4 and ignores loopback, private, and duplicate addresses", () => {
    expect(customDomainIpv4(interfaces("127.0.0.1", "172.17.0.2", "100.64.0.2", "8.8.8.8", "8.8.8.8"), "")).toBe("8.8.8.8");
    expect(customDomainIpv4({ eth0: [{ ...interfaces("8.8.8.8").eth0[0]!, internal: true }] }, "")).toBeNull();
  });

  it("does not guess the target for containers or multiple public interfaces", () => {
    expect(customDomainIpv4(interfaces("172.17.0.2"), "")).toBeNull();
    expect(customDomainIpv4(interfaces("8.8.8.8", "1.1.1.1"), "")).toBeNull();
    expect(customDomainIpv4({}, "")).toBeNull();
  });

  it("allows an explicit public proxy IP without echo services or DNS lookups", () => {
    expect(customDomainIpv4(interfaces("172.17.0.2"), " 8.8.8.8 ")).toBe("8.8.8.8");
  });

  it.each(["127.0.0.1", "192.168.1.5", "169.254.169.254", "203.0.113.1", "::1", "2606:4700::1111", "https://bots.company.com", "invalid"])("does not fall back to a guess when an override is invalid: %s", (configured) => {
    expect(customDomainIpv4(interfaces("8.8.8.8"), configured)).toBeNull();
  });
});

describe("custom domain input", () => {
  it.each([
    ["bots.company.com", "https://bots.company.com"],
    [" https://BOTS.company.com/ ", "https://bots.company.com"],
    ["https://bots.company.com:443", "https://bots.company.com"],
    ["bots.company.com.", "https://bots.company.com"],
    ["böts.company.com", "https://xn--bts-sna.company.com"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeCustomDomain(input)).toBe(expected);
  });

  it.each([
    "", "http://bots.company.com", "https://bots.company.com:8443", "bots.company.com/pair",
    "https://user:password@bots.company.com", "https://bots.company.com/#code=secret",
    "https://bots.company.com?code=secret", "https://bots.company.com\\@127.0.0.1",
    "bots.company.com\n/path", "https://bots.comp\nany.com", "https://bots.%63ompany.com",
    "localhost", "bots.localhost", "bots.local", "bots.internal", "bots.test", "bots.invalid",
    "127.0.0.1", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://2130706433",
    "https://0x7f000001", "https://0177.0.0.1", "https://8.8.8.8", "https://-bots.company.com",
    "https://bots..company.com", `${"a".repeat(64)}.company.com`, "file:///etc/passwd",
  ])("rejects unsafe or non-domain input %s", (input) => {
    expect(() => normalizeCustomDomain(input)).toThrow();
  });
});

describe("public-address policy", () => {
  it.each(["8.8.8.8", "1.1.1.1", "93.184.215.14", "2606:4700:4700::1111", "2001:4860:4860::8888"])("allows %s", (address) => {
    expect(isPublicDomainAddress(address)).toBe(true);
  });
  it.each([
    "0.0.0.0", "0.2.3.4", "10.2.3.4", "100.64.1.2", "127.0.0.1", "169.254.169.254",
    "172.16.4.2", "172.31.255.255", "192.0.0.1", "192.0.2.4", "192.88.99.1",
    "192.168.1.2", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "garbage",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fd12::1", "fe80::1",
    "ff00::1", "64:ff9b::a00:1", "2001:db8::1", "2001::1", "2002:7f00:1::", "3fff::1",
  ])("rejects %s", (address) => {
    expect(isPublicDomainAddress(address)).toBe(false);
  });
});

describe("domain verification", () => {
  it("requires this server's descriptor and independent temporary proof", async () => {
    const { verifier, lookup, request } = fixture();
    const result = await verifier.verify("bots.company.com");
    expect(result).toMatchObject({ origin: "https://bots.company.com" });
    expect(Number.isNaN(Date.parse(result.verifiedAt))).toBe(false);
    expect(lookup).toHaveBeenCalledExactlyOnceWith("bots.company.com");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![0].pathname).toBe("/.well-known/openmausbot/environment");
    const token = request.mock.calls[1]![0].pathname.slice(CUSTOM_DOMAIN_CHALLENGE_PATH.length);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(verifier.challenge(token)).toBeNull();
    expect(request.mock.calls[0]![2].aborted).toBe(true);
  });

  it("rejects even a mixed public/private DNS answer before any request", async () => {
    const { verifier, request } = fixture({ addresses: [publicAddress, { address: "169.254.169.254", family: 4 }] });
    await expect(verifier.verify("bots.company.com")).rejects.toThrow("public internet addresses");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects empty DNS answers or mismatched address families", async () => {
    for (const addresses of [[], [{ address: "8.8.8.8", family: 6 }]]) {
      await expect(fixture({ addresses }).verifier.verify("bots.company.com")).rejects.toThrow("public internet addresses");
    }
  });

  it("pins one checked DNS result across both requests, even if DNS would change", async () => {
    const { verifier, lookup, request } = fixture();
    lookup.mockResolvedValueOnce([publicAddress]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await verifier.verify("bots.company.com");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map((call) => call[1])).toEqual([publicAddress, publicAddress]);
  });

  it("supports public IPv6-only domains", async () => {
    const address = { address: "2606:4700:4700::1111", family: 6 };
    const { verifier, request } = fixture({ addresses: [address] });
    await verifier.verify("bots.company.com");
    expect(request.mock.calls[0]![1]).toEqual(address);
  });

  it("rejects another OMB server", async () => {
    const { verifier, request } = fixture();
    request.mockResolvedValueOnce({ environmentId: "another-server" });
    await expect(verifier.verify("bots.company.com")).rejects.toThrow("does not point to this");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("a copied public descriptor or echoed challenge token cannot pass proof", async () => {
    const { verifier, request } = fixture();
    let token = "";
    request.mockImplementation(async (url) => {
      if (url.pathname.endsWith("/environment")) return { environmentId };
      token = url.pathname.slice(CUSTOM_DOMAIN_CHALLENGE_PATH.length);
      expect(verifier.challenge("unknown-token")).toBeNull();
      expect(verifier.challenge(token)?.proof).not.toBe(token);
      return { environmentId, proof: token };
    });
    await expect(verifier.verify("bots.company.com")).rejects.toThrow("could not prove");
    expect(verifier.challenge(token)).toBeNull();
  });

  it("allows only one bounded verification at a time", async () => {
    const { verifier } = fixture();
    const first = verifier.verify("bots.company.com");
    await expect(verifier.verify("other.company.com")).rejects.toMatchObject({ status: 409 });
    await first;
    await expect(verifier.verify("other.company.com")).resolves.toMatchObject({ origin: "https://other.company.com" });
  });

  it("times out DNS without starting a later request and releases its lock", async () => {
    vi.useFakeTimers();
    const { verifier, lookup, request } = fixture({ timeoutMs: 100 });
    let resolveDns!: (addresses: LookupAddress[]) => void;
    lookup.mockImplementationOnce(() => new Promise((resolve) => { resolveDns = resolve; }));
    const result = expect(verifier.verify("bots.company.com")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(101);
    await result;
    resolveDns([publicAddress]);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    await expect(verifier.verify("bots.company.com")).resolves.toHaveProperty("origin");
  });

  it("aborts a stalled request and expires the challenge", async () => {
    vi.useFakeTimers();
    const { verifier, request } = fixture({ timeoutMs: 100 });
    let token = "";
    let signal: AbortSignal | undefined;
    request.mockImplementation(async (url, _address, requestSignal) => {
      if (url.pathname.endsWith("/environment")) return { environmentId };
      token = url.pathname.slice(CUSTOM_DOMAIN_CHALLENGE_PATH.length);
      signal = requestSignal;
      return new Promise(() => {});
    });
    const result = expect(verifier.verify("bots.company.com")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(101);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(verifier.challenge(token)).toBeNull();
  });

  it("does not expose arbitrary DNS, certificate, response, or network error details", async () => {
    const { verifier, lookup, request } = fixture();
    lookup.mockRejectedValueOnce(new Error("private DNS detail secret"));
    await expect(verifier.verify("bots.company.com")).rejects.toThrow("could not be found in DNS");
    request.mockRejectedValueOnce(new Error("private network detail secret"));
    await expect(verifier.verify("bots.company.com")).rejects.toThrow("secure connection");
  });
});

describe("HTTPS transport", () => {
  let responder: (url: URL) => { status: number; body: string };
  let responses: PassThrough[];
  beforeEach(() => {
    responses = [];
    httpsRequestMock.mockReset().mockImplementation((url: URL, _options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const req = Object.assign(new EventEmitter(), {
        end() {
          queueMicrotask(() => {
            const result = responder(url);
            const stream = Object.assign(new PassThrough(), { statusCode: result.status });
            responses.push(stream);
            callback(stream as unknown as IncomingMessage);
            stream.end(result.body);
          });
        },
      });
      return req;
    });
  });

  it("keeps TLS hostname verification, passes no credentials, and pins lookup", async () => {
    const verifier = createCustomDomainVerifier({ environmentId, lookup: async () => [publicAddress] });
    responder = (url) => ({
      status: 200,
      body: JSON.stringify(url.pathname.endsWith("/environment") ? { environmentId }
        : verifier.challenge(url.pathname.slice(CUSTOM_DOMAIN_CHALLENGE_PATH.length))),
    });
    await verifier.verify("bots.company.com");
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of httpsRequestMock.mock.calls as [URL, RequestOptions][]) {
      expect(url.hostname).toBe("bots.company.com");
      expect(options).toMatchObject({ method: "GET", agent: false, rejectUnauthorized: true });
      expect(options.headers).toEqual({ Accept: "application/json", "User-Agent": "OpenMausBot-domain-check" });
      const callback = vi.fn();
      options.lookup!("bots.company.com", { all: false }, callback);
      expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
      callback.mockClear();
      options.lookup!("bots.company.com", { all: true }, callback);
      expect(callback).toHaveBeenCalledWith(null, [publicAddress]);
    }
  });

  it.each([301, 302, 307, 308, 401, 404, 500])("does not follow or accept HTTP %s", async (status) => {
    const verifier = createCustomDomainVerifier({ environmentId, lookup: async () => [publicAddress] });
    responder = () => ({ status, body: JSON.stringify({ environmentId }) });
    await expect(verifier.verify("bots.company.com")).rejects.toThrow("verification page");
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(responses[0]!.destroyed).toBe(true);
  });

  it("bounds response bytes and destroys oversized streams", async () => {
    const verifier = createCustomDomainVerifier({ environmentId, lookup: async () => [publicAddress] });
    responder = () => ({ status: 200, body: "x".repeat(16_385) });
    await expect(verifier.verify("bots.company.com")).rejects.toThrow("unexpected response");
    expect(responses[0]!.destroyed).toBe(true);
  });

  it("rejects HTML and malformed JSON without returning their contents", async () => {
    const verifier = createCustomDomainVerifier({ environmentId, lookup: async () => [publicAddress] });
    responder = () => ({ status: 200, body: "<html>private error page</html>" });
    await expect(verifier.verify("bots.company.com")).rejects.toThrow("did not return OpenMausBot data");
  });
});
