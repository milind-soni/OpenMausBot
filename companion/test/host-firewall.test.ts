import { describe, expect, it, vi } from "vitest";

// A laptop on Wi-Fi with Docker installed: the QR leads with the Wi-Fi address.
vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  networkInterfaces: () => ({
    docker0: [{ family: "IPv4", internal: false, address: "172.17.0.1" }],
    wlan0: [{ family: "IPv4", internal: false, address: "192.168.1.40" }],
  }),
}));

import { companionState } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { createHostFirewallCheck, ufwAllowsPort, ufwBlocksPort, ufwDropsIncoming, ufwEnabled } from "../src/host-firewall.ts";

const ENABLED = "# /etc/ufw/ufw.conf\n#\n\n# Set to yes to start on boot.\nENABLED=yes\n\nLOGLEVEL=low\n";
const DEFAULTS = 'IPV6=yes\nDEFAULT_INPUT_POLICY="DROP"\nDEFAULT_OUTPUT_POLICY="ACCEPT"\n';
// What `ufw default deny incoming` plus two LocalSend-style allows leave in user.rules.
const RULES = [
  "*filter",
  ":ufw-user-input - [0:0]",
  "### RULES ###",
  "",
  "### tuple ### allow udp 53317 0.0.0.0/0 any 0.0.0.0/0 in",
  "-A ufw-user-input -p udp --dport 53317 -j ACCEPT",
  "",
  "### tuple ### allow tcp 53317 0.0.0.0/0 any 0.0.0.0/0 in",
  "-A ufw-user-input -p tcp --dport 53317 -j ACCEPT",
  "",
  "### tuple ### allow udp 53 172.17.0.1 any 172.16.0.0/12 in comment=616c6c6f772d646f636b65722d646e73",
  "",
  "### END RULES ###",
].join("\n");

const files = (over: Record<string, string | null> = {}) => {
  const all: Record<string, string | null> = {
    "/etc/ufw/ufw.conf": ENABLED,
    "/etc/default/ufw": DEFAULTS,
    "/etc/ufw/user.rules": RULES,
    ...over,
  };
  return vi.fn((path: string) => all[path] ?? null);
};

describe("ufw's files", () => {
  it("reads ENABLED and the default input policy", () => {
    expect(ufwEnabled(ENABLED)).toBe(true);
    expect(ufwEnabled("ENABLED=no\n")).toBe(false);
    expect(ufwEnabled('  ENABLED="yes"  ')).toBe(true);
    expect(ufwEnabled("#ENABLED=yes\n")).toBe(false);
    expect(ufwEnabled(null)).toBe(false);
    expect(ufwDropsIncoming(DEFAULTS)).toBe(true);
    expect(ufwDropsIncoming('DEFAULT_INPUT_POLICY="REJECT"')).toBe(true);
    expect(ufwDropsIncoming('DEFAULT_INPUT_POLICY="ACCEPT"')).toBe(false);
    expect(ufwDropsIncoming(null)).toBe(true);
  });

  it("finds a rule that lets TCP in on the port, and only that", () => {
    expect(ufwAllowsPort(RULES, 8810)).toBe(false);
    expect(ufwAllowsPort(RULES, 53317)).toBe(true);
    expect(ufwAllowsPort(null, 8810)).toBeNull();
    const rule = (tuple: string) => `${RULES}\n### tuple ### ${tuple}\n`;
    expect(ufwAllowsPort(rule("allow tcp 8810 0.0.0.0/0 any 0.0.0.0/0 in"), 8810)).toBe(true);
    expect(ufwAllowsPort(rule("allow any 8810 0.0.0.0/0 any 192.168.0.0/16 in"), 8810)).toBe(true);
    expect(ufwAllowsPort(rule("limit tcp 8000:9000 0.0.0.0/0 any 0.0.0.0/0 in_wlan0"), 8810)).toBe(true);
    expect(ufwAllowsPort(rule("allow_log tcp 80,8810 0.0.0.0/0 any 0.0.0.0/0 in"), 8810)).toBe(true);
    expect(ufwAllowsPort(rule("allow tcp 8810 0.0.0.0/0 any 0.0.0.0/0 MausBot - in"), 8810)).toBe(true);
    expect(ufwAllowsPort(rule("allow tcp any 0.0.0.0/0 any 192.168.1.0/24 in"), 8810)).toBe(true);
    expect(ufwAllowsPort(rule("allow udp 8810 0.0.0.0/0 any 0.0.0.0/0 in"), 8810)).toBe(false);
    expect(ufwAllowsPort(rule("deny tcp 8810 0.0.0.0/0 any 0.0.0.0/0 in"), 8810)).toBe(false);
    expect(ufwAllowsPort(rule("allow tcp 8810 0.0.0.0/0 any 0.0.0.0/0 out"), 8810)).toBe(false);
    expect(ufwAllowsPort(rule("allow tcp 8811 0.0.0.0/0 any 0.0.0.0/0 in"), 8810)).toBe(false);
  });

  it("blocks only when ufw is on, drops by default, and no readable rule allows the port", () => {
    expect(ufwBlocksPort(8810, files())).toBe(true);
    // user.rules is root-only on some distributions: can't tell, so the hint shows.
    expect(ufwBlocksPort(8810, files({ "/etc/ufw/user.rules": null }))).toBe(true);
    expect(ufwBlocksPort(8810, files({ "/etc/ufw/ufw.conf": "ENABLED=no\n" }))).toBe(false);
    expect(ufwBlocksPort(8810, files({ "/etc/ufw/ufw.conf": null }))).toBe(false);
    expect(ufwBlocksPort(8810, files({ "/etc/default/ufw": 'DEFAULT_INPUT_POLICY="ACCEPT"\n' }))).toBe(false);
    expect(ufwBlocksPort(8810, files({ "/etc/ufw/user.rules": `${RULES}\n### tuple ### allow tcp 8810 0.0.0.0/0 any 0.0.0.0/0 in\n` }))).toBe(false);
  });
});

describe("createHostFirewallCheck", () => {
  it("never reads anything off Linux", () => {
    const read = files();
    for (const platform of ["darwin", "win32"] as const) expect(createHostFirewallCheck({ platform, read })(8810)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("reads at most once per interval and sees an allow rule after it", () => {
    let clock = 0;
    let rules = RULES;
    const read = vi.fn((path: string) => (path === "/etc/ufw/user.rules" ? rules : path === "/etc/ufw/ufw.conf" ? ENABLED : DEFAULTS));
    const check = createHostFirewallCheck({ platform: "linux", read, now: () => clock, maxAgeMs: 10_000 });
    expect(check(8810)).toBe("ufw");
    const reads = read.mock.calls.length;
    expect(check(8810)).toBe("ufw");
    expect(read.mock.calls.length).toBe(reads);
    rules = `${RULES}\n### tuple ### allow tcp 8810 0.0.0.0/0 any 0.0.0.0/0 in\n`;
    clock = 10_000;
    expect(check(8810)).toBeNull();
  });
});

describe("companionState hostFirewall", () => {
  const state = (pairing: boolean, answer: "ufw" | null = "ufw") => {
    const devices = new DeviceRegistry();
    if (pairing) devices.openPairing();
    const hostFirewall = vi.fn(() => answer);
    const result = companionState({
      devices,
      companionPort: 8810,
      discovery: () => ({ advertising: false, name: "Test computer" }),
      publicNetworks: () => new Set(),
      hostFirewall,
    });
    return { result, hostFirewall };
  };

  it("says so while pairing, for the device port, with the Wi-Fi address ahead of docker0", () => {
    const { result, hostFirewall } = state(true);
    expect(result.lan).toBe("192.168.1.40");
    expect(result.hostFirewall).toBe("ufw");
    expect(hostFirewall).toHaveBeenCalledWith(8810);
  });

  it("says nothing when nothing blocks, and reads nothing while no pairing is open", () => {
    expect(state(true, null).result).not.toHaveProperty("hostFirewall");
    const { result, hostFirewall } = state(false);
    expect(result).not.toHaveProperty("hostFirewall");
    expect(hostFirewall).not.toHaveBeenCalled();
  });
});
