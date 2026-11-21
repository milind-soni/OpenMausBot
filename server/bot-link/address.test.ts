import { describe, expect, it } from "vitest";

import { linkedAddress, placeKey } from "../../electron/bot-link-address.mjs";
import { linkedId, parseLinked, peerKey } from "./protocol.ts";

describe("a bot of the other place has one address", () => {
  it("the app's main process and the server cut the same place key and build the same address", () => {
    for (const place of ["11111111-1111-4111-8111-111111111111", "cloud-1", "ünïcode place", ""]) {
      expect(placeKey(place)).toBe(peerKey(place));
      for (const bot of ["scout", "bot-with-dashes-1", "a_b"]) {
        expect(linkedAddress(place, bot)).toBe(linkedId(peerKey(place), bot));
        expect(parseLinked(linkedAddress(place, bot))).toEqual({ peer: peerKey(place), botId: bot });
      }
    }
  });
});
