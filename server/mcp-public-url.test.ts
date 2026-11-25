import { describe, expect, it, vi } from "vitest";

import { publicMcpUrl, type HostLookup } from "./mcp-public-url.ts";

const table: Record<string, string[]> = {
  "mcp.example.com": ["34.117.59.81", "2606:4700:4700::1111"],
  "intranet.example.com": ["10.1.2.3"],
  "mixed.example.com": ["34.117.59.81", "127.0.0.1"],
  "empty.example.com": [],
};
const lookup: HostLookup = vi.fn(async (host: string) => {
  const addresses = table[host];
  if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return addresses.map((address) => ({ address }));
});

describe("publicMcpUrl", () => {
  it.each([
    "https://mcp.example.com/mcp",
    "https://mcp.example.com./mcp?team=acme",
    "https://34.117.59.81/mcp",
    "https://[2606:4700:4700::1111]/mcp",
  ])("counts %s as public", async (url) => {
    await expect(publicMcpUrl(url, lookup)).resolves.toBe(true);
  });

  it.each([
    "http://mcp.example.com/mcp",
    "http://localhost:3000/mcp",
    "https://localhost/mcp",
    "https://app.localhost/mcp",
    "https://127.0.0.1:8799/mcp",
    "https://192.168.1.5/mcp",
    "https://[::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://printer.local/mcp",
    "https://wiki.internal/mcp",
    "https://nas.lan/mcp",
    "https://router.home.arpa/mcp",
    "https://box.tail1234.ts.net/mcp",
    "https://intranet.example.com/mcp",
    "https://mixed.example.com/mcp",
    "https://empty.example.com/mcp",
    "https://unknown.example.com/mcp",
    "not a url",
  ])("keeps %s behind the person's yes", async (url) => {
    await expect(publicMcpUrl(url, lookup)).resolves.toBe(false);
  });

  it("decides a local name or an address literal without asking DNS", async () => {
    vi.mocked(lookup).mockClear();
    for (const url of ["https://printer.local/mcp", "https://192.168.1.5/mcp", "https://34.117.59.81/mcp", "http://mcp.example.com/mcp"]) await publicMcpUrl(url, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});
