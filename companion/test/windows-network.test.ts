// A Windows PC on a network Windows calls Public drops every phone's
// connection at its firewall, however right the QR's address is. The sidecar
// finds that network so the Wi-Fi pairing panel can say what to change.
import { describe, expect, it, vi } from "vitest";

// The Oct 3 PC: WSL's virtual switch listed first, the real Wi-Fi second.
vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  networkInterfaces: () => ({
    "vEthernet (WSL (Hyper-V firewall))": [{ family: "IPv4", internal: false, address: "172.19.96.1" }],
    "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.1.34" }],
  }),
}));

import { companionState } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { createPublicNetworkCheck, publicNetworkAliases } from "../src/windows-network.ts";

describe("publicNetworkAliases", () => {
  it("reads the adapters Get-NetConnectionProfile has on a Public network", () => {
    const output = [
      "Wi-Fi\tPublic",
      "vEthernet (WSL (Hyper-V firewall))\tPrivate",
      "Ethernet 2\tDomainAuthenticated",
      "以太网\tPublic",
      "",
    ].join("\r\n");
    expect([...publicNetworkAliases(output)]).toEqual(["Wi-Fi", "以太网"]);
  });

  it("treats anything unreadable as not Public", () => {
    expect(publicNetworkAliases("").size).toBe(0);
    expect(publicNetworkAliases("Public\nWi-Fi Public\n\tPublic").size).toBe(0);
  });
});

describe("createPublicNetworkCheck", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("never asks Windows on macOS or Linux", () => {
    const run = vi.fn(async () => "Wi-Fi\tPublic");
    for (const platform of ["darwin", "linux"] as const) {
      expect(createPublicNetworkCheck({ platform, run })().size).toBe(0);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("answers at once, asks once at a time, and asks again only when the answer is stale", async () => {
    let clock = 0;
    let output = "Wi-Fi\tPublic";
    const run = vi.fn(async () => output);
    const check = createPublicNetworkCheck({ platform: "win32", run, now: () => clock, maxAgeMs: 15_000 });

    expect(check().size).toBe(0);
    expect(check().size).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    await settle();
    expect([...check()]).toEqual(["Wi-Fi"]);
    expect(run).toHaveBeenCalledTimes(1);

    // Someone sets the network to Private; the next stale read finds out.
    output = "Wi-Fi\tPrivate";
    clock = 15_000;
    expect([...check()]).toEqual(["Wi-Fi"]);
    await settle();
    expect(check().size).toBe(0);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("says nothing when PowerShell fails", async () => {
    let clock = 0;
    const run = vi.fn<() => Promise<string>>().mockResolvedValueOnce("Wi-Fi\tPublic").mockRejectedValueOnce(new Error("timed out"));
    const check = createPublicNetworkCheck({ platform: "win32", run, now: () => clock, maxAgeMs: 1 });
    check();
    await settle();
    clock = 1;
    expect([...check()]).toEqual(["Wi-Fi"]);
    await settle();
    expect(check().size).toBe(0);
  });
});

describe("companionState publicNetwork", () => {
  const state = (publicAliases: string[], pairing: boolean) => {
    const devices = new DeviceRegistry();
    if (pairing) devices.openPairing();
    const publicNetworks = vi.fn(() => new Set(publicAliases));
    const result = companionState({
      devices,
      companionPort: 8810,
      discovery: () => ({ advertising: false, name: "Miguel's computer" }),
      publicNetworks,
    });
    return { result, publicNetworks };
  };

  it("names the adapter the Wi-Fi QR leads with when Windows has it on a Public network", () => {
    const { result } = state(["Wi-Fi"], true);
    expect(result.lan).toBe("192.168.1.34");
    expect(result.publicNetwork).toBe("Wi-Fi");
  });

  it("says nothing when only an adapter the QR does not lead with is Public", () => {
    expect(state(["vEthernet (WSL (Hyper-V firewall))"], true).result).not.toHaveProperty("publicNetwork");
  });

  it("does not ask Windows while no pairing window is open", () => {
    const { result, publicNetworks } = state(["Wi-Fi"], false);
    expect(result).not.toHaveProperty("publicNetwork");
    expect(publicNetworks).not.toHaveBeenCalled();
  });
});
