import { describe, expect, it } from "vitest";
import { lanPairingHint } from "./serve.ts";

describe("lanPairingHint", () => {
  it("stays silent when there is no private address to suggest", () => {
    expect(lanPairingHint([], 8799)).toBeNull();
  });

  it("points at the private address and port a desktop client can pair with", () => {
    expect(lanPairingHint(["192.168.1.5"], 8799)).toBe(
      "on this network: pair a desktop client via OMB_PUBLIC_URL=http://192.168.1.5:8799 (serve behind any local http proxy on that address)",
    );
  });

  it("uses the first address when several interfaces are private", () => {
    expect(lanPairingHint(["192.168.1.5", "10.0.0.3"], 8799)).toBe(
      "on this network: pair a desktop client via OMB_PUBLIC_URL=http://192.168.1.5:8799 (serve behind any local http proxy on that address)",
    );
  });
});
