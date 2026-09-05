// The control plane's own front door.
//
// This server binds loopback and serves the pairing page, which makes it feel
// unreachable from outside. It is not: a browser on the victim's machine is
// inside that boundary, and any page on the internet can aim a form at it.
// These tests pin the rule that keeps that from mattering.
import { type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlServer, hostCandidates, originIsLoopback } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";

let control: Server;
let port = 0;
let devices: DeviceRegistry;
let connectedDeviceIds: string[] = [];
let disconnectedDeviceIds: string[] = [];
let tailscaleRefreshes = 0;
let completedTailscaleRefreshes = 0;

const ask = async (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};

beforeAll(async () => {
  devices = new DeviceRegistry();
  let hostedUrl: string | null = null;
  control = createControlServer({
    devices,
    companionPort: 8810,
    secretPublicKey: () => "BIPBQ12_dWnF1DZLsTZO3Vg0NGjds5-jp9h3jhjr2To7bJelczS0LM82rfXV68PmSJhz2ePosj3fL974XckCpDU",
    hostedUrl: () => hostedUrl,
    setHostedUrl: (next) => {
      hostedUrl = next;
    },
    discovery: () => ({ advertising: false, name: "Test computer" }),
    connectedDeviceIds: () => connectedDeviceIds,
    disconnectDevice: (deviceId) => {
      disconnectedDeviceIds.push(deviceId);
      connectedDeviceIds = connectedDeviceIds.filter((connectedId) => connectedId !== deviceId);
    },
    refreshTailscale: async () => {
      tailscaleRefreshes += 1;
      await Promise.resolve();
      completedTailscaleRefreshes += 1;
    },
  });
  port = await new Promise<number>((resolve) =>
    control.listen(0, "127.0.0.1", () => resolve((control.address() as { port: number }).port)),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => control.close(() => resolve()));
});

describe("origins the control server will change state for", () => {
  it("controls cloud desktop access per paired device", async () => {
    const { code } = devices.openPairing();
    const paired = devices.redeem(code, "iPhone");
    if ("error" in paired) throw new Error(paired.error);

    expect(paired.device.cloudDesktopAccess).toBe(false);
    disconnectedDeviceIds = [];
    expect((await ask("POST", `/devices/${paired.device.id}/cloud-desktop`)).status).toBe(200);
    expect(devices.authenticate(paired.token)?.cloudDesktopAccess).toBe(true);
    expect(disconnectedDeviceIds).toEqual([paired.device.id]);
    disconnectedDeviceIds = [];
    expect((await ask("DELETE", `/devices/${paired.device.id}/cloud-desktop`)).status).toBe(200);
    expect(devices.authenticate(paired.token)?.cloudDesktopAccess).toBe(false);
    expect(disconnectedDeviceIds).toEqual([paired.device.id]);
    expect((await ask("POST", "/devices/missing/cloud-desktop")).status).toBe(404);
  });

  it("reports a permission write failure without dropping the control server", async () => {
    const [device] = devices.list();
    const writable = devices as unknown as { persist: () => void };
    const persist = writable.persist;
    writable.persist = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    try {
      const failed = await ask("POST", `/devices/${device.id}/cloud-desktop`);
      expect(failed).toEqual({
        status: 500,
        body: { error: "could not save cloud desktop access" },
      });
      expect(devices.list().find((candidate) => candidate.id === device.id)?.cloudDesktopAccess).toBe(false);
      expect((await ask("GET", "/state")).status).toBe(200);
    } finally {
      writable.persist = persist;
    }
  });

  it("refuses a state change from a foreign page", async () => {
    // The attack this exists for: a form POST needs no preflight, and the
    // Host header on it is the loopback one this server already approves.
    // Same-origin policy hides the reply, so the code is never read — but a
    // pairing window opens on the victim's screen regardless.
    const { status, body } = await ask("POST", "/pairing", { origin: "https://evil.example" });
    expect(status).toBe(403);
    expect(body.error).toContain("cross-origin");
    // and it did not happen anyway
    expect((await ask("GET", "/state")).body.pairing).toBeNull();
  });

  it("refuses an opaque origin", async () => {
    // A sandboxed iframe and a file:// page both send the literal string
    // "null". Treating that as absent would hand the hole straight back.
    expect((await ask("POST", "/pairing", { origin: "null" })).status).toBe(403);
    expect((await ask("DELETE", "/pairing", { origin: "null" })).status).toBe(403);
  });

  it("allows the page it serves, and no other loopback origin", async () => {
    // Exactly this server's origin, not merely a loopback one. The page below
    // is served from here and its writes carry this authority, so nothing is
    // lost by narrowing — while a loopback origin on another port is another
    // program's page, which has no more business opening a pairing window
    // than a page on the internet does.
    const { status } = await ask("POST", "/pairing", { origin: `http://127.0.0.1:${port}` });
    expect(status).toBe(201);
    expect((await ask("GET", "/state")).body.pairing).not.toBeNull();
    await ask("DELETE", "/pairing", { origin: `http://127.0.0.1:${port}` });

    // A different loopback port is a different origin. So is the same port
    // under a name that resolves to the same address: `Host` here is
    // `127.0.0.1:<port>` — what the request was addressed to — and the match
    // is on the string, because the alternative is a resolver in a CSRF check.
    expect((await ask("POST", "/pairing", { origin: `http://127.0.0.1:${port + 1}` })).status).toBe(403);
    expect((await ask("POST", "/pairing", { origin: `http://localhost:${port}` })).status).toBe(403);
    expect((await ask("GET", "/state")).body.pairing).toBeNull();
  });

  it("allows a client that sends no origin at all", async () => {
    // The Electron main process, which is not a browser and is the normal
    // desktop path. A CSRF check aimed at it would break the toggle.
    expect((await ask("POST", "/pairing")).status).toBe(201);
    await ask("DELETE", "/pairing");
  });

  it("refreshes Tailscale before returning state without opening pairing", async () => {
    const before = tailscaleRefreshes;
    const refreshed = await ask("POST", "/tailscale/refresh");

    expect(refreshed.status).toBe(200);
    expect(tailscaleRefreshes).toBe(before + 1);
    expect(completedTailscaleRefreshes).toBe(tailscaleRefreshes);
    expect(refreshed.body.pairing).toBeNull();
  });

  it("refuses a Tailscale refresh from a foreign page", async () => {
    const before = tailscaleRefreshes;
    expect((await ask("POST", "/tailscale/refresh", { origin: "https://evil.example" })).status).toBe(403);
    expect(tailscaleRefreshes).toBe(before);
  });

  it("does not let a stale conditional close cancel a replacement code", async () => {
    const first = await ask("POST", "/pairing");
    const second = await ask("POST", "/pairing");

    await ask("DELETE", `/pairing?expectedToken=${encodeURIComponent(first.body.pairing.token)}`);
    expect((await ask("GET", "/state")).body.pairing.token).toBe(second.body.pairing.token);
    await ask("DELETE", `/pairing?expectedToken=${encodeURIComponent(second.body.pairing.token)}`);
    expect((await ask("GET", "/state")).body.pairing).toBeNull();
  });

  it("refuses a foreign origin on a safe method too", async () => {
    // This line used to expect 200, on the argument that a GET changes
    // nothing and the same-origin policy already hides the reply. The
    // stricter rule won the reconciliation, and it is the right one twice
    // over. Nothing legitimate reads this API cross-origin at all — the only
    // browser client is the page this server serves itself — so allowing it
    // buys nothing. And a check that has to decide which methods are "safe"
    // is a check with a list in it, which is a list that goes stale: the day
    // a read is added that leaks something (a pairing code, an address, the
    // device list) the exemption is already in place and nobody revisits it.
    // So: any cross-origin request, any method, is refused.
    const { status, body } = await ask("GET", "/state", { origin: "https://evil.example" });
    expect(status).toBe(403);
    expect(body.error).toContain("cross-origin");
  });
});

describe("hostCandidates", () => {
  it("orders by reachability: tailnet name, then LAN, then the mDNS name last", () => {
    // 100.121.5.6 is the bare tailnet address: excluded outright, because iOS
    // refuses plain HTTP to 100.64/10 and a candidate that can never succeed
    // only slows the walk down. The synthetic mDNS name is last — it resolves
    // only while the sidecar runs.
    const hosts = hostCandidates(["100.121.5.6", "192.168.1.42", "10.0.0.7"], "macbook.tail1234.ts.net");
    expect(hosts.slice(0, 3)).toEqual(["macbook.tail1234.ts.net", "192.168.1.42", "10.0.0.7"]);
    expect(hosts.at(-1)).toMatch(/^openmausbot-[0-9a-f]{8}\.local$/);
    expect(hosts).not.toContain("100.121.5.6");
  });

  it("skips the tailnet name when Tailscale is not part of the picture", () => {
    // A MagicDNS name left over from a cached read is only dialable while a
    // tailnet address exists; without one it would be a dead first candidate.
    expect(hostCandidates(["192.168.1.42"], "stale.tail1234.ts.net")[0]).toBe("192.168.1.42");
    expect(hostCandidates(["100.121.5.6", "192.168.1.42"], null)[0]).toBe("192.168.1.42");
  });

  it("is what /state hands the pairing panel", async () => {
    const { status, body } = await ask("GET", "/state");
    expect(status).toBe(200);
    expect(Array.isArray(body.hosts)).toBe(true);
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.secretPublicKey).toBe("BIPBQ12_dWnF1DZLsTZO3Vg0NGjds5-jp9h3jhjr2To7bJelczS0LM82rfXV68PmSJhz2ePosj3fL974XckCpDU");
    // Whatever this machine's interfaces are, the mDNS fallback is always
    // present and always last.
    expect(body.hosts.at(-1)).toMatch(/^openmausbot-[0-9a-f]{8}\.local$/);
    expect(body.endpoints.at(-1)).toMatchObject({ kind: "bonjour", priority: 300 });
    expect(body.endpoints.at(-1).url).toMatch(/^http:\/\/openmausbot-[0-9a-f]{8}\.local:8810$/);
  });

  it("reports only the device ids backed by live authenticated streams", async () => {
    connectedDeviceIds = ["phone-live"];
    try {
      expect((await ask("GET", "/state")).body.connectedDeviceIds).toEqual(["phone-live"]);
    } finally {
      connectedDeviceIds = [];
    }
  });

  it("disconnects streams only after a device is successfully revoked", async () => {
    const { code } = devices.openPairing();
    const paired = devices.redeem(code, "Revoked phone");
    if ("error" in paired) throw new Error(paired.error);
    disconnectedDeviceIds = [];
    connectedDeviceIds = [paired.device.id];

    expect((await ask("DELETE", "/devices/missing-device")).status).toBe(404);
    expect(disconnectedDeviceIds).toEqual([]);
    expect(connectedDeviceIds).toEqual([paired.device.id]);

    const revoked = await ask("DELETE", `/devices/${paired.device.id}`);
    expect(revoked.status).toBe(200);
    expect(disconnectedDeviceIds).toEqual([paired.device.id]);
    expect(revoked.body.connectedDeviceIds).toEqual([]);
  });
});

describe("hosted endpoint advertisement", () => {
  it("publishes and withdraws only a complete HTTPS origin", async () => {
    const headers = { "content-type": "application/json" };
    const published = await ask(
      "PUT",
      "/hosted-endpoint",
      headers,
      JSON.stringify({ url: "https://C-Opaque.OpenMausBot.Test/" }),
    );
    expect(published.status).toBe(200);
    expect(published.body.endpoints[0]).toEqual({
      kind: "hosted",
      priority: 0,
      url: "https://c-opaque.openmausbot.test",
    });

    expect(
      (await ask("PUT", "/hosted-endpoint", headers, JSON.stringify({ url: "http://unsafe.test" }))).status,
    ).toBe(400);
    expect((await ask("GET", "/state")).body.endpoints[0]).toMatchObject({ kind: "hosted" });

    const withdrawn = await ask(
      "PUT",
      "/hosted-endpoint",
      headers,
      JSON.stringify({ url: null }),
    );
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.endpoints.some((endpoint: { kind: string }) => endpoint.kind === "hosted")).toBe(false);
  });

  it("accepts exactly one string-or-null url field", async () => {
    const headers = { "content-type": "application/json" };
    for (const body of [
      {},
      { url: null, extra: true },
      { url: 42 },
      { url: false },
      [],
      null,
      "https://c-opaque.openmausbot.test",
    ]) {
      const result = await ask("PUT", "/hosted-endpoint", headers, JSON.stringify(body));
      expect(result).toEqual({ status: 400, body: { error: "invalid JSON body" } });
    }

    expect((await ask("PUT", "/hosted-endpoint", headers, JSON.stringify({ url: null }))).status).toBe(200);
  });

  it("refuses a hosted-endpoint body larger than 4096 bytes", async () => {
    const request = ask(
      "PUT",
      "/hosted-endpoint",
      { "content-type": "application/json" },
      JSON.stringify({ url: `https://${"a".repeat(4096)}.example` }),
    );
    // The server deliberately tears down an oversized upload as soon as the
    // byte limit is crossed, so native fetch reports a transport failure
    // rather than waiting for (or parsing) the remainder of the body.
    await expect(request).rejects.toThrow();
    expect((await ask("GET", "/state")).body.endpoints.some(
      (endpoint: { kind: string }) => endpoint.kind === "hosted",
    )).toBe(false);
  });
});

describe("originIsLoopback", () => {
  it("accepts loopback and absence, and nothing else", () => {
    expect(originIsLoopback(undefined)).toBe(true);
    expect(originIsLoopback("http://127.0.0.1:8811")).toBe(true);
    expect(originIsLoopback("http://localhost:3000")).toBe(true);
    expect(originIsLoopback("http://[::1]:8811")).toBe(true);

    expect(originIsLoopback("null")).toBe(false);
    expect(originIsLoopback("https://evil.example")).toBe(false);
    // the prefix trick: a hostname that merely starts with the loopback one
    expect(originIsLoopback("https://127.0.0.1.evil.example")).toBe(false);
    expect(originIsLoopback("https://localhost.evil.example")).toBe(false);
  });
});
