import { expect, it } from "vitest";

import { isPrivateHost } from "./private-host";

it("private: loopback, home and office ranges, Tailscale, link-local and local names", () => {
  for (const host of ["127.0.0.1", "localhost", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.20", "100.64.0.1", "100.127.255.254",
    "169.254.10.1", "::1", "[::1]", "fd12:3456::1", "fe80::1", "mac-mini.tail1234.ts.net", "kitchen.local", "hetzner-1", "MAC.LOCAL."]) {
    expect(isPrivateHost(host), host).toBe(true);
  }
});

it("public: everything else, including look-alikes just outside each range", () => {
  for (const host of ["203.0.113.9", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "11.0.0.1",
    "2001:db8::1", "maus.example.com", "ts.net.example.com", "local.example.com", "999.1.1.1", ""]) {
    expect(isPrivateHost(host), host).toBe(false);
  }
});
