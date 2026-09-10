import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { canPairDevices, lastSeen, minutesLeft, ServerPairingCard } from "./ServerPairingCard";

describe("pairing devices from a hosted server's settings", () => {
  it("is offered to the owner on the box and to admin sessions, never to chat-only sessions", () => {
    expect(canPairDevices({ kind: "loopback" })).toBe(true);
    expect(canPairDevices({ kind: "session", id: "s", label: "Her iPad", scopes: ["admin", "client"], expiresAt: 1 })).toBe(true);
    expect(canPairDevices({ kind: "session", id: "s", label: "Staff phone", scopes: ["client"], expiresAt: 1 })).toBe(false);
    expect(canPairDevices({ kind: "unauthenticated", error: "pair" })).toBe(false);
    expect(canPairDevices(null)).toBe(false);
  });

  it("counts down whole minutes and describes when a device was last seen", () => {
    expect(minutesLeft(60_000 * 5 + 1, 0)).toBe(6);
    expect(minutesLeft(60_000 * 5, 0)).toBe(5);
    expect(minutesLeft(0, 1)).toBe(0);
    expect(lastSeen(1_000, 30_000)).toBe("just now");
    expect(lastSeen(0, 3 * 60_000)).toBe("3 min ago");
    expect(lastSeen(0, 5 * 3_600_000)).toBe("5 h ago");
    expect(lastSeen(0, 3 * 86_400_000)).toBe("3 d ago");
  });

  it("renders nothing until it knows who is asking", () => {
    expect(renderToStaticMarkup(createElement(ServerPairingCard))).toBe("");
  });
});
