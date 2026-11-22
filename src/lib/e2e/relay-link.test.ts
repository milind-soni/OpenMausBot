import { describe, expect, it } from "vitest";

import { b64u } from "./bytes.ts";
import { relayRoute } from "./relay-link.ts";

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
