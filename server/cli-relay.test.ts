import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { parseArgs, runLogin } from "./cli.ts";
import { relayPairingBlock, relayProblemLines, showRelayPairing } from "./cli-pairing.ts";
import type { PhoneRelayStatus } from "./phone-relay.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startControlPlaneStub } from "./testing/control-plane-stub.ts";

const status = (over: Partial<PhoneRelayStatus> = {}): PhoneRelayStatus => ({ relay: "connected", node: "relay1.openmausbot.com", grant: "ok", phones: 1, maxPhones: 20, ...over });
const invite = "openmausbot://pair?address=relay-only.invalid%3A443&token=omb_pair_x&e2e=eyJ2IjoxfQ";

describe("openmausbot serve --relay", () => {
  it("is off unless asked for, joins any way in but --tunnel, and never a local start", () => {
    expect(parseArgs(["serve"], {})).not.toHaveProperty("relay");
    expect(parseArgs(["serve", "--relay"], {})).toMatchObject({ command: "serve", relay: true, tunnel: false });
    expect(parseArgs(["serve", "--relay", "--domain", "maus.example.com"], {})).toMatchObject({ relay: true, domain: "maus.example.com" });
    expect(parseArgs(["serve", "--tailscale", "--relay"], {})).toMatchObject({ relay: true, tailscale: true });
    expect(parseArgs(["service", "install", "--relay"], {})).toMatchObject({ command: "service", relay: true });
    expect(parseArgs(["serve", "--relay", "--tunnel"], {})).toEqual({ error: "choose one of --relay (phones through MausBot Relay) and --tunnel (a public address)" });
    expect(parseArgs(["serve", "--tailscale", "--tunnel"], {})).toEqual({ error: "choose one of --tailscale (your tailnet) and --tunnel (a public address)" });
    expect(parseArgs(["--local", "--relay"], {})).toEqual({ error: "--local cannot be combined with a remote-access option" });
  });

  it("prints the relay QR for a phone code, and the usual block for everything else", () => {
    const body = { inviteUrl: invite, expiresAt: Date.now() + 600_000, relay: status() };
    const block = relayPairingBlock(body, true, "openmausbot")!;
    expect(block).toContain("Scan with the MausBot app. It connects through MausBot Relay, end-to-end encrypted");
    expect(block).toContain("Paired phones: 1 of 20. Remove one: openmausbot devices revoke ID");
    expect(relayPairingBlock(body, false, "openmausbot")).toBeNull();
    expect(relayPairingBlock({ ...body, relay: undefined }, true, "openmausbot")).toBeNull();
    expect(relayPairingBlock({ ...body, inviteUrl: "openmausbot://pair?address=https%3A%2F%2Fmaus.example.com&token=omb_pair_x" }, true, "openmausbot")).toBeNull();
  });

  it("says why a phone cannot pair yet, in the person's terms", () => {
    expect(relayProblemLines(null, "openmausbot")).toEqual(["MausBot Relay is off on this server. Start it with: openmausbot serve --relay"]);
    expect(relayProblemLines(status({ grant: "signed-out", relay: "off" }), "openmausbot")[0]).toMatch(/^MausBot Relay needs this machine signed in to a MausBot account: openmausbot login --relay/);
    expect(relayProblemLines(status({ grant: "unavailable", relay: "off" }), "npx openmausbot")[0]).toMatch(/not available for this machine right now\. The server keeps working here/);
    expect(relayProblemLines(status({ relay: "connecting", node: null }), "openmausbot")[0]).toMatch(/^Can't reach MausBot Relay yet\. The server keeps working here/);
    expect(relayProblemLines(status(), "openmausbot")).toEqual([]);
  });

  it("waits for the relay before making a code, and makes none it can't use", async () => {
    const reads = [status({ grant: "waiting", relay: "off" }), status({ relay: "connecting" }), status()];
    const lines: string[] = [];
    let minted = 0;
    const mint = async () => `code ${++minted}`;
    expect(await showRelayPairing({ status: async () => reads.shift() ?? status(), mint, log: (line) => lines.push(line), prefix: "openmausbot", waitMs: 5_000 })).toBe(true);
    expect(lines).toEqual(["code 1"]);

    lines.length = 0;
    expect(await showRelayPairing({ status: async () => status({ grant: "signed-out", relay: "off" }), mint, log: (line) => lines.push(line), prefix: "openmausbot", waitMs: 0 })).toBe(false);
    expect(minted).toBe(1);
    expect(lines[1]).toBe("Then: openmausbot pair --phone");
  });

  it("signs a machine in for the relay without reserving one of the scarce tunnel addresses", async () => {
    const stub = await startControlPlaneStub();
    const dataDir = mkdtempSync(join(tmpdir(), "omb-login-relay-"));
    vi.stubEnv("OMB_CONTROL_PLANE_URL", stub.url);
    try {
      const lines: string[] = [];
      const io = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(`error: ${line}`), ask: async () => stub.otp };
      const options = parseArgs(["login", "--relay", "--email", "vps@example.test", "--data-dir", dataDir], {});
      if ("error" in options) throw new Error(options.error);
      expect(await runLogin(options, io)).toBe(0);
      expect(lines).toEqual(["Signed in as vps@example.test.", "No public address reserved: phones reach this machine through MausBot Relay.", expect.stringMatching(/^Serve there with: {2}.*serve --relay$/)]);
      expect(stub.calls).toContain("POST /v1/installations");
      expect(stub.calls.filter((call) => call.includes("/endpoint"))).toEqual([]);
      const file = join(dataDir, "tunnel-account.json");
      expect(JSON.parse(readFileSync(file, "utf8")).companionInstallationCredential).toMatch(/^omb_install_/);
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      vi.unstubAllEnvs();
      await stub.close();
      await removeTempDir(dataDir);
    }
  });
});
