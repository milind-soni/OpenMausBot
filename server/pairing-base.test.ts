import { expect, it } from "vitest";

import { pairingLinkBase, signInMailTarget } from "./pairing-base.ts";

it("the configured address always wins", () => {
  expect(pairingLinkBase("https://maus.example.com", "http://192.168.1.20:8799")).toBe("https://maus.example.com");
});

it("falls back to the session's own address only when other devices can safely use it", () => {
  expect(pairingLinkBase(null, "https://maus.example.com")).toBe("https://maus.example.com");
  expect(pairingLinkBase(null, "http://192.168.1.20:8799")).toBe("http://192.168.1.20:8799");
  expect(pairingLinkBase(null, "http://mac-mini.tail1234.ts.net:8799")).toBe("http://mac-mini.tail1234.ts.net:8799");
  expect(pairingLinkBase(null, "http://203.0.113.9:8799")).toBeNull();
  expect(pairingLinkBase(null, "http://maus.example.com")).toBeNull();
  expect(pairingLinkBase(null, "http://127.0.0.1:8799")).toBeNull();
  expect(pairingLinkBase(null, "http://localhost:8799")).toBeNull();
  expect(pairingLinkBase(null, null)).toBeNull();
});

it("an emailed code names the configured server, or a private one, never a host a stranger's request claims", () => {
  expect(signInMailTarget("https://maus.example.com", "https://evil.example")).toBe("maus.example.com");
  expect(signInMailTarget(null, "http://192.168.1.20:8799")).toBe("192.168.1.20:8799");
  expect(signInMailTarget(null, "https://evil.example")).toBeNull();
  expect(signInMailTarget(null, "http://127.0.0.1:8799")).toBeNull();
});
