import { request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createControlServer, hostCandidates, initialControlToken, originIsLoopback } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";

let control: Server;
let port = 0;
let devices: DeviceRegistry;
let connectedDeviceIds: string[] = [];
let disconnectedDeviceIds: string[] = [];
let revokedDeviceIds: string[] = [];
let tailscaleRefreshes = 0;
let completedTailscaleRefreshes = 0;
const CONTROL_TOKEN = "c".repeat(43);
let controlToken: string | null = CONTROL_TOKEN;
const withToken = { "x-openmausbot-control-token": CONTROL_TOKEN };

const ask = async (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
  token: Record<string, string> = withToken,
): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...token, ...headers }, body });
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
    controlToken: () => controlToken,
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
    revoked: (deviceId) => {
      revokedDeviceIds.push(deviceId);
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

describe("the per-launch control token", () => {
  it("refuses every route without it, so a page served from the control port cannot pair a device", async () => {
    for (const [method, path] of [["POST", "/pairing"], ["GET", "/state"], ["DELETE", "/pairing"], ["POST", "/tailscale/refresh"], ["POST", "/devices/x/browser-control"], ["DELETE", "/devices/x"]]) {
      const tokenless = await ask(method, path, { origin: `http://127.0.0.1:${port}` }, undefined, {});
      expect(tokenless.status, `${method} ${path}`).toBe(403);
      expect(JSON.stringify(tokenless.body)).not.toMatch(/omb_pair_|"code"/);
    }
    expect((await ask("POST", "/pairing", {}, undefined, { "x-openmausbot-control-token": "d".repeat(43) })).status).toBe(403);
    expect((await ask("POST", "/pairing", {}, undefined, { "x-openmausbot-control-token": CONTROL_TOKEN.slice(1) })).status).toBe(403);
    expect(devices.pairing()).toBeNull();
  });

  it("serves the page itself, which holds no state, without one", async () => {
    const page = await ask("GET", "/", {}, undefined, {});
    expect(page.status).toBe(200);
    expect(page.body).toContain("x-openmausbot-control-token");
    expect(page.body).not.toContain(CONTROL_TOKEN);
  });

  it("waits for the app's token when the app launched the sidecar, and otherwise takes a script's or makes one", () => {
    expect(initialControlToken({ OMB_CONTROL_TOKEN: CONTROL_TOKEN }, true)).toBeNull();
    expect(initialControlToken({ OMB_CONTROL_TOKEN: CONTROL_TOKEN }, false)).toBe(CONTROL_TOKEN);
    for (const env of [{}, { OMB_CONTROL_TOKEN: "short" }, { OMB_CONTROL_TOKEN: `${"c".repeat(42)}!` }]) {
      const token = initialControlToken(env, false);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(token).not.toBe(CONTROL_TOKEN);
    }
  });

  it("fails closed until the launching app has sent it", async () => {
    controlToken = null;
    try {
      expect((await ask("GET", "/state")).status).toBe(403);
      expect((await ask("POST", "/pairing")).status).toBe(403);
    } finally {
      controlToken = CONTROL_TOKEN;
    }
    expect(devices.pairing()).toBeNull();
  });
});

describe("malformed requests", () => {
  it("answers a request target that is not a URL with 400", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const sent = request({ hostname: "127.0.0.1", port, path: "//[", headers: withToken }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      sent.on("error", reject);
      sent.end();
    });
    expect(status).toBe(400);
    expect((await ask("GET", "/state")).status).toBe(200);
  });
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
    // A form POST needs no preflight and carries the approved loopback Host.
    const { status, body } = await ask("POST", "/pairing", { origin: "https://evil.example" });
    expect(status).toBe(403);
    expect(body.error).toContain("cross-origin");
    expect((await ask("GET", "/state")).body.pairing).toBeNull();
  });

  it("refuses an opaque origin", async () => {
    // Sandboxed iframes and file:// pages send the literal string "null".
    expect((await ask("POST", "/pairing", { origin: "null" })).status).toBe(403);
    expect((await ask("DELETE", "/pairing", { origin: "null" })).status).toBe(403);
  });

  it("allows the page it serves, and no other loopback origin", async () => {
    const { status } = await ask("POST", "/pairing", { origin: `http://127.0.0.1:${port}` });
    expect(status).toBe(201);
    expect((await ask("GET", "/state")).body.pairing).not.toBeNull();
    await ask("DELETE", "/pairing", { origin: `http://127.0.0.1:${port}` });

    expect((await ask("POST", "/pairing", { origin: `http://127.0.0.1:${port + 1}` })).status).toBe(403);
    expect((await ask("POST", "/pairing", { origin: `http://localhost:${port}` })).status).toBe(403);
    expect((await ask("GET", "/state")).body.pairing).toBeNull();
  });

  it("allows a client that sends no origin at all", async () => {
    // The Electron main process is not a browser and sends no Origin.
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
    const { status, body } = await ask("GET", "/state", { origin: "https://evil.example" });
    expect(status).toBe(403);
    expect(body.error).toContain("cross-origin");
  });
});

describe("hostCandidates", () => {
  it("orders by reachability: tailnet name, then LAN, then the mDNS name last", () => {
    const hosts = hostCandidates(["100.121.5.6", "192.168.1.42", "10.0.0.7"], "macbook.tail1234.ts.net");
    expect(hosts.slice(0, 3)).toEqual(["macbook.tail1234.ts.net", "192.168.1.42", "10.0.0.7"]);
    expect(hosts.at(-1)).toMatch(/^openmausbot-[0-9a-f]{8}\.local$/);
    expect(hosts).not.toContain("100.121.5.6");
  });

  it("skips the tailnet name when Tailscale is not part of the picture", () => {
    // A cached MagicDNS name is dialable only while a tailnet address exists.
    expect(hostCandidates(["192.168.1.42"], "stale.tail1234.ts.net")[0]).toBe("192.168.1.42");
    expect(hostCandidates(["100.121.5.6", "192.168.1.42"], null)[0]).toBe("192.168.1.42");
  });

  it("is what /state hands the pairing panel", async () => {
    const { status, body } = await ask("GET", "/state");
    expect(status).toBe(200);
    expect(Array.isArray(body.hosts)).toBe(true);
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.secretPublicKey).toBe("BIPBQ12_dWnF1DZLsTZO3Vg0NGjds5-jp9h3jhjr2To7bJelczS0LM82rfXV68PmSJhz2ePosj3fL974XckCpDU");
    expect(body.hosts.at(-1)).toMatch(/^openmausbot-[0-9a-f]{8}\.local$/);
    expect(body.endpoints.at(-1)).toMatchObject({ kind: "bonjour", priority: 300 });
    expect(body.endpoints.at(-1).url).toMatch(/^http:\/\/openmausbot-[0-9a-f]{8}\.local:8810$/);
  });

  it("says when its device list is only an unreadable file", async () => {
    expect((await ask("GET", "/state")).body).not.toHaveProperty("devicesUnreadable");
    const unreadable = vi.spyOn(devices, "devicesUnreadable").mockReturnValue(true);
    try {
      expect((await ask("GET", "/state")).body.devicesUnreadable).toBe(true);
    } finally {
      unreadable.mockRestore();
    }
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

  it("keeps a device whose removal cannot be saved, says so, and removes it on retry", async () => {
    const { code } = devices.openPairing();
    const paired = devices.redeem(code, "Stubborn phone");
    if ("error" in paired) throw new Error(paired.error);
    disconnectedDeviceIds = [];
    revokedDeviceIds = [];
    const writable = devices as unknown as { persist: () => void };
    const persist = writable.persist;
    writable.persist = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    try {
      expect(await ask("DELETE", `/devices/${paired.device.id}`)).toEqual({
        status: 500,
        body: { error: "could not save the device removal" },
      });
    } finally {
      writable.persist = persist;
    }
    expect(devices.list().some((device) => device.id === paired.device.id)).toBe(true);
    expect(disconnectedDeviceIds).toEqual([]);
    expect(revokedDeviceIds).toEqual([]);

    expect((await ask("DELETE", `/devices/${paired.device.id}`)).status).toBe(200);
    expect(devices.authenticate(paired.token)).toBeNull();
    expect(revokedDeviceIds).toEqual([paired.device.id]);
  });

  it("tells the harness about a revoked device, and only about a revoke", async () => {
    const { code } = devices.openPairing();
    const paired = devices.redeem(code, "Lost phone");
    if ("error" in paired) throw new Error(paired.error);
    revokedDeviceIds = [];

    expect((await ask("DELETE", "/devices/missing-device")).status).toBe(404);
    expect((await ask("POST", `/devices/${paired.device.id}/cloud-desktop`)).status).toBe(200);
    expect((await ask("DELETE", `/devices/${paired.device.id}/cloud-desktop`)).status).toBe(200);
    expect(revokedDeviceIds).toEqual([]);

    expect((await ask("DELETE", `/devices/${paired.device.id}`)).status).toBe(200);
    expect(revokedDeviceIds).toEqual([paired.device.id]);
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
    // The server tears an oversized upload down as soon as the limit is
    // crossed, so fetch reports a transport failure.
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
    expect(originIsLoopback("https://127.0.0.1.evil.example")).toBe(false);
    expect(originIsLoopback("https://localhost.evil.example")).toBe(false);
  });
});
