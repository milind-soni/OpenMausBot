import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { classifyTailscaleStderr, clearLeftoverTailscaleServe, explainTailscaleFailure, parseTailscaleStatus, tailscaleMarker, tailscaleServe, type TailscaleStatus } from "./tailscale.ts";

describe("tailscale helpers", () => {
  it("reads the MagicDNS name, addresses and state from status --json", () => {
    const status = parseTailscaleStatus("/usr/bin/tailscale", JSON.stringify({
      BackendState: "Running",
      CertDomains: ["mini.tail1234.ts.net"],
      Self: { DNSName: "mini.tail1234.ts.net.", TailscaleIPs: ["100.64.0.7", "fd7a:115c:a1e0::7"] },
    }));
    expect(status).toEqual({ cli: "/usr/bin/tailscale", dnsName: "mini.tail1234.ts.net", addresses: ["100.64.0.7", "fd7a:115c:a1e0::7"], backendState: "Running", httpsEnabled: true });
    expect(parseTailscaleStatus("t", JSON.stringify({ BackendState: "Running" }))?.httpsEnabled).toBe(false);
    expect(parseTailscaleStatus("t", "{}")?.dnsName).toBeNull();
    expect(parseTailscaleStatus("t", "not json")).toBeNull();
  });

  it("classifies stderr into a closed set and never needs the raw text again", () => {
    expect(classifyTailscaleStderr("Logged out.\nLog in at: https://login.tailscale.com/a/tskey-auth-secret")).toBe("not-logged-in");
    expect(classifyTailscaleStderr("failed to connect to local tailscaled; is Tailscale running?")).toBe("not-running");
    expect(classifyTailscaleStderr("Access denied: serve config denied; use 'sudo tailscale set --operator=USER'")).toBe("needs-operator");
    expect(classifyTailscaleStderr("error: HTTPS is not enabled for this tailnet")).toBe("https-not-enabled");
    expect(classifyTailscaleStderr("something else entirely")).toBe("unknown");
    for (const reason of ["not-installed", "not-logged-in", "not-running", "no-magicdns", "needs-operator", "https-not-enabled", "unknown"] as const) {
      expect(explainTailscaleFailure(reason).length).toBeGreaterThan(20);
      expect(explainTailscaleFailure(reason)).not.toContain("tskey");
    }
  });
});

describe("serve --tailscale", () => {
  const status: TailscaleStatus = { cli: "/usr/bin/tailscale", dnsName: "mini.tail1234.ts.net", addresses: [], backendState: "Running", httpsEnabled: true };
  const fakeServe = (exitCode: number | null, stderr = "") => {
    const calls: string[][] = [];
    const children: Array<EventEmitter & { kill(signal: string): void; killed: string[] }> = [];
    const spawnImpl = ((_cli: string, args: string[]) => {
      calls.push(args);
      const child: EventEmitter & { stderr: EventEmitter; killed: string[]; kill(signal: string): void } = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(), killed: [] as string[], kill(signal: string) { child.killed.push(signal); setImmediate(() => child.emit("exit", null)); },
      });
      children.push(child);
      if (exitCode !== null) setImmediate(() => { child.stderr.emit("data", Buffer.from(stderr)); child.emit("exit", exitCode); });
      return child;
    }) as never;
    return { calls, children, spawnImpl };
  };

  it("serves in the foreground, notes it, and turns it off when serve stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-ts-"));
    try {
      const fake = fakeServe(null);
      const served = await tailscaleServe(status, 8799, { dataDir: dir, settleMs: 20, spawnImpl: fake.spawnImpl });
      if ("failure" in served) throw new Error(served.failure);
      expect(served.origin).toBe("https://mini.tail1234.ts.net");
      expect(fake.calls).toEqual([["serve", "--https=443", "http://127.0.0.1:8799"]]);
      expect(fake.calls[0]).not.toContain("--bg");
      expect(existsSync(tailscaleMarker(dir))).toBe(true);
      await served.stop();
      expect(fake.children[0]!.killed).toEqual(["SIGTERM"]);
      expect(existsSync(tailscaleMarker(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks first: HTTPS certificates on, and no other MausBot server already on this name; a serve that exits says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-ts-"));
    try {
      const fake = fakeServe(null);
      expect(await tailscaleServe({ ...status, httpsEnabled: false }, 8799, { dataDir: dir, spawnImpl: fake.spawnImpl })).toEqual({ failure: "https-not-enabled" });
      expect(await tailscaleServe(status, 8799, { dataDir: dir, spawnImpl: fake.spawnImpl, otherServer: async () => true })).toEqual({ failure: "other-server" });
      expect(fake.calls).toEqual([]);
      const refused = fakeServe(1, "Access denied: serve config denied");
      expect(await tailscaleServe(status, 8799, { dataDir: dir, settleMs: 500, spawnImpl: refused.spawnImpl })).toEqual({ failure: "needs-operator" });
      expect(existsSync(tailscaleMarker(dir))).toBe(false);
      expect(explainTailscaleFailure("other-server")).toContain("different MausBot server");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns off a share a crashed run left behind, and nothing without its note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-ts-"));
    try {
      expect(await clearLeftoverTailscaleServe(dir)).toBe(false);
      writeFileSync(tailscaleMarker(dir), JSON.stringify({ cli: process.execPath, httpsPort: 443, localPort: 8799 }));
      expect(await clearLeftoverTailscaleServe(dir)).toBe(true);
      expect(existsSync(tailscaleMarker(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
