// An 8-hour Local VM screen stream, compressed: about 10 GB in 12 KiB frames (some 870k records) through the real
// sidecar and the real relay, with a relay token refresh and a control-socket replacement mid-run. Opt-in like the
// nightly fuzz: OMB_E2E_SOAK=1 (OMB_E2E_SOAK_BYTES to change the size). Run it through the heavy-run lock.
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freePort, pairViaRelay, spawnRelay, startRig, waitFor, type RelayProcess, type Rig } from "./rig.ts";

const ENABLED = process.env.OMB_E2E_SOAK === "1";
const TOTAL = Number(process.env.OMB_E2E_SOAK_BYTES) || 10 * 1024 ** 3;
const rssMb = (pid: number) => Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024;

let rig: Rig;
let relay: RelayProcess;

describe.skipIf(!ENABLED)("a long screen stream through the relay", () => {
  beforeAll(async () => {
    const port = await freePort();
    rig = await startRig(async (publicKey) => {
      relay = await spawnRelay(publicKey, port);
      return relay.url;
    });
  }, 30_000);

  afterAll(async () => {
    await rig?.stop();
    await relay?.stop();
  });

  it("keeps the data socket through a token refresh and a control-socket replacement, with flat memory", async () => {
    const { token, session } = await pairViaRelay(rig);
    const samples: Array<{ at: number; sidecar: number; relay: number; phone: number }> = [];
    let received = 0;
    let mismatches = 0;
    let refreshed = false;
    let replaced = false;
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const req = request(
        { path: `/api/attachments/soak-${TOTAL}.mp3`, host: "companion", headers: { authorization: `Bearer ${token}` }, createConnection: () => session.openStream() },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            if (chunk[0] !== received % 251) mismatches += 1;
            received += chunk.length;
            const fraction = received / TOTAL;
            if (samples.length < Math.floor(fraction * 20) + 1) {
              samples.push({ at: received, sidecar: rssMb(rig.sidecarPid), relay: rssMb(relay.pid), phone: process.memoryUsage().rss / 1024 ** 2 });
            }
            if (!refreshed && fraction > 0.3) {
              refreshed = true;
              void rig.control("PUT", "/e2e/relay", { hostId: rig.hid, nodes: ["relay1.openmausbot.com"], relayToken: rig.relayToken() });
            }
            if (!replaced && fraction > 0.6) {
              replaced = true;
              // A different node list makes the sidecar redial: a new control socket replaces the old one.
              void rig.control("PUT", "/e2e/relay", { hostId: rig.hid, nodes: ["relay1.openmausbot.com", "relay2.openmausbot.com"], relayToken: rig.relayToken() });
            }
          });
          res.on("end", resolve);
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
    const seconds = (Date.now() - started) / 1000;
    const records = session.records.received;
    console.log(JSON.stringify({ bytes: received, records, seconds, mbPerSecond: Math.round(received / 1024 ** 2 / seconds), samples }));
    expect(received).toBe(TOTAL);
    expect(mismatches).toBe(0);
    expect(refreshed && replaced).toBe(true);
    expect(session.state).toBe("open");
    await waitFor(async () => (await rig.control("GET", "/state")).e2e.relay === "connected", 10_000);
    // Flat: after the first tenth, no process grows by more than 64 MB.
    const settled = samples.filter((sample) => sample.at > TOTAL / 10);
    for (const key of ["sidecar", "relay", "phone"] as const) {
      const values = settled.map((sample) => sample[key]);
      expect(Math.max(...values) - values[0], key).toBeLessThan(64);
    }
    session.shutdown();
  }, 60 * 60_000);
});
