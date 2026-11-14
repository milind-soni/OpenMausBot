// DESIGN §6.3: a relay that tampers with what it splices. Every attack must end in a closed session or a refused
// pairing, never in data delivered.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { b64u } from "../../src/e2e/credentials.ts";
import { generateKeyPair, NoiseError, phoneHello, TRANSPORT_RELAY } from "../../src/e2e/noise.ts";
import { fromB64u } from "../../src/e2e/credentials.ts";
import { startFakeRelay, type FakeRelay } from "./fake-relay.ts";
import { http, pairViaRelay, startRig, type Rig } from "./rig.ts";

let rig: Rig;
let relay: FakeRelay;
let deviceToken = "";

beforeAll(async () => {
  rig = await startRig(async (publicKey) => {
    relay = await startFakeRelay({ keys: new Map([["k1", publicKey]]) });
    return relay.url;
  });
  const paired = await pairViaRelay(rig);
  deviceToken = paired.token;
  paired.session.shutdown();
}, 30_000);

afterAll(async () => {
  await rig?.stop();
  await relay?.close();
});

const state = () => rig.control("GET", "/state");
const flip = (data: Buffer) => {
  const out = Buffer.from(data);
  out[out.length - 1] ^= 1;
  return out;
};

/** One 300 KB upload through a tampered relay: it must never reach the harness. */
async function attempt(tamper: NonNullable<FakeRelay["tamper"]>): Promise<"refused" | "delivered"> {
  relay.tamper = tamper;
  try {
    const session = await rig.viaRelay(await state(), deviceToken);
    const reply = await http(session, "POST", "/api/files", { token: deviceToken, body: randomBytes(300_000), headers: { "content-type": "application/octet-stream" } });
    session.shutdown();
    return reply.status === 201 ? "delivered" : "refused";
  } catch {
    return "refused";
  } finally {
    relay.tamper = null;
  }
}

describe("a malicious relay", () => {
  it("can't swap the computer's key: a message 2 it wrote is a hard stop", async () => {
    relay.tamper = (direction, data, index) =>
      direction === "toPhone" && index === 0 && data.length > 81 ? Buffer.concat([generateKeyPair().publicKey, randomBytes(data.length - 65)]) : data;
    await expect(rig.viaRelay(await state(), deviceToken)).rejects.toBeInstanceOf(NoiseError);
    relay.tamper = null;
  });

  it("can't pose as the phone: a message 1 without the psk is refused", async () => {
    const forged = phoneHello(
      { remoteStatic: fromB64u((await state()).e2e.descriptor!.k)!, psk: randomBytes(32), transport: TRANSPORT_RELAY },
      Buffer.from(JSON.stringify({ v: 1, conn: b64u(randomBytes(16)) })),
      "",
    ).message1;
    expect(await attempt((direction, data, index) => (direction === "toHost" && index === 0 ? forged : data))).toBe("refused");
  });

  it("can't replay, drop, truncate or flip a record", async () => {
    let previous: Buffer | null = null;
    expect(await attempt((direction, data, index) => {
      if (direction !== "toHost" || index < 1) return data;
      const out = index === 3 && previous ? previous : data;
      previous = data;
      return out;
    })).toBe("refused");
    expect(await attempt((direction, data, index) => (direction === "toHost" && index === 2 ? null : data))).toBe("refused");
    expect(await attempt((direction, data, index) => (direction === "toHost" && index === 2 ? data.subarray(0, data.length - 1) : data))).toBe("refused");
    expect(await attempt((direction, data, index) => (direction === "toHost" && index === 2 ? flip(data) : data))).toBe("refused");
  });

  it("can't reflect the computer's own record back to it", async () => {
    let fromComputer: Buffer | null = null;
    let reflected = false;
    expect(await attempt((direction, data, index) => {
      if (direction === "toPhone" && index >= 1) fromComputer ??= data;
      if (direction !== "toHost" || index < 2 || !fromComputer || reflected) return data;
      reflected = true;
      return fromComputer;
    })).toBe("refused");
  });

  it("can't pass off a message 2 from an earlier session", async () => {
    let old: Buffer | null = null;
    relay.tamper = (direction, data, index) => {
      if (direction === "toPhone" && index === 0) old = data;
      return data;
    };
    (await rig.viaRelay(await state(), deviceToken)).shutdown();
    relay.tamper = (direction, data, index) => (direction === "toPhone" && index === 0 && old ? old : data);
    await expect(rig.viaRelay(await state(), deviceToken)).rejects.toBeInstanceOf(NoiseError);
    relay.tamper = null;
  });

  it("can close the session with 4001, but the phone doesn't take it for a removal", async () => {
    const session = await rig.viaRelay(await state(), deviceToken);
    relay.forgeClose(4001);
    expect(await session.closed).toBe(4001);
    expect(session.removed).toBe(false);
    expect((await state()).devices).toHaveLength(1);
  });
});
