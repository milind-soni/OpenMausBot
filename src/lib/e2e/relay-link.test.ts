import { afterEach, describe, expect, it, vi } from "vitest";

import { b64u } from "./bytes.ts";
import { RelayLink, relayRoute } from "./relay-link.ts";

const k = b64u(new Uint8Array(65).fill(4));
const h = b64u(new Uint8Array(16).fill(1));

describe("relayRoute", () => {
  it("takes a descriptor's relay half: the key, the host and each node's phone URL in order", () => {
    const route = relayRoute({ v: 1, k, h, r: ["relay2.openmausbot.com", "relay1.openmausbot.com"] });
    expect(route?.remoteStatic).toEqual(new Uint8Array(65).fill(4));
    expect(route?.hostId).toEqual(new Uint8Array(16).fill(1));
    expect(route?.urls).toEqual(["wss://relay2.openmausbot.com/v1/phone", "wss://relay1.openmausbot.com/v1/phone"]);
    expect(relayRoute({ v: 1, k, h, r: ["relay1.openmausbot.com"] }, { nodeUrl: (node) => `ws://127.0.0.1:9/${node}` })?.urls)
      .toEqual(["ws://127.0.0.1:9/relay1.openmausbot.com"]);
  });

  it("is null for a descriptor with no relay, and for any malformed part", () => {
    for (const bad of [
      null, "text", [], { v: 1, k }, { v: 2, k, h, r: ["relay1.openmausbot.com"] },
      { v: 1, k: b64u(new Uint8Array(64)), h, r: ["relay1.openmausbot.com"] },
      { v: 1, k, h: b64u(new Uint8Array(15)), r: ["relay1.openmausbot.com"] },
      { v: 1, k, h, r: [] },
      { v: 1, k, h, r: ["relay1.openmausbot.com.evil.example"] },
      { v: 1, k, h, r: ["evil.example"] },
      { v: 1, k, h, r: Array.from({ length: 5 }, (_, i) => `relay${i + 1}.openmausbot.com`) },
    ]) expect(relayRoute(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("RelayLink", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a request whose signal is already aborted with its reason, without dialing the relay", async () => {
    let dials = 0;
    vi.stubGlobal("WebSocket", class {
      constructor() {
        dials += 1;
        throw new Error("relay unreachable");
      }
    });
    const link = new RelayLink(relayRoute({ v: 1, k, h, r: ["relay1.openmausbot.com"] })!, "token");
    const reason = new Error("cancelled by the page");
    await expect(link.fetch("/api/auth/session", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(dials).toBe(0);
  });

  it("stops waiting for the relay with the caller's reason when its signal aborts, and leaves the dial to the others", async () => {
    const sockets: Array<{ onerror: (() => void) | null; onclose: ((event: { code: number }) => void) | null }> = [];
    vi.stubGlobal("WebSocket", class {
      binaryType = "blob";
      onopen = null;
      onerror = null;
      onclose = null;
      onmessage = null;
      constructor() {
        sockets.push(this);
      }
      close() {}
    });
    const link = new RelayLink(relayRoute({ v: 1, k, h, r: ["relay1.openmausbot.com"] })!, "token");
    const stop = new AbortController();
    const cancelled = link.fetch("/api/auth/session", { signal: stop.signal });
    const other = link.fetch("/api/bots");
    const reason = new Error("cancelled by the page");
    stop.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onclose?.({ code: 1006 });
    await expect(other).rejects.toThrow();
    await expect(cancelled).rejects.toBe(reason);
    link.close();
  });
});
