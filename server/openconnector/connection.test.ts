import { describe, expect, it } from "vitest";

import { OPENCONNECTOR_DEFAULT_URL } from "../../shared/openconnector.ts";
import { isLoopbackAddress, openConnectorAddress, openConnectorHost } from "./connection.ts";

const loopback = { loopback: true, managed: false };
const managed = { loopback: true, managed: true };

describe("openConnectorAddress", () => {
  it("defaults to the standard single-file address", () => {
    expect(openConnectorAddress("", loopback)).toEqual({ ok: true, address: OPENCONNECTOR_DEFAULT_URL });
    expect(openConnectorAddress(undefined, loopback)).toEqual({ ok: true, address: OPENCONNECTOR_DEFAULT_URL });
  });

  it("accepts the standard loopback http address", () => {
    expect(openConnectorAddress("http://127.0.0.1:3000/mcp", loopback)).toEqual({ ok: true, address: "http://127.0.0.1:3000/mcp" });
    expect(openConnectorAddress("http://localhost:3000/mcp/", loopback)).toEqual({ ok: true, address: "http://localhost:3000/mcp" });
    expect(openConnectorAddress("http://[::1]:3000/mcp", loopback)).toEqual({ ok: true, address: "http://[::1]:3000/mcp" });
  });

  it("accepts an https address on any host when it is not managed", () => {
    expect(openConnectorAddress("https://connector.example.com/mcp", loopback))
      .toEqual({ ok: true, address: "https://connector.example.com/mcp" });
  });

  it("refuses plain http off this computer", () => {
    const result = openConnectorAddress("http://192.168.1.10:3000/mcp", loopback);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/https:\/\//u);
  });

  it("refuses a non-loopback address for a managed connection", () => {
    const result = openConnectorAddress("https://connector.example.com/mcp", managed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/this computer/u);
  });

  it("refuses credentials, query and hash in the address", () => {
    for (const raw of [
      "http://user:pass@127.0.0.1:3000/mcp",
      "http://127.0.0.1:3000/mcp?key=abc",
      "http://127.0.0.1:3000/mcp#frag",
    ]) {
      expect(openConnectorAddress(raw, loopback).ok).toBe(false);
    }
  });

  it("refuses an address that carries a key after the endpoint path", () => {
    const result = openConnectorAddress("https://connector.example.com/mcp/sk-1234", loopback);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/key/u);
  });

  it("refuses a non-URL", () => {
    expect(openConnectorAddress("not a url", loopback).ok).toBe(false);
    expect(openConnectorAddress("ftp://127.0.0.1/mcp", loopback).ok).toBe(false);
  });

  it("on a Cloud refuses plain http even to loopback names", () => {
    const result = openConnectorAddress("http://127.0.0.1:3000/mcp", { loopback: false, managed: false });
    expect(result.ok).toBe(false);
  });
});

describe("openConnectorHost", () => {
  it("shows the host of a valid address and the raw text otherwise", () => {
    expect(openConnectorHost("http://127.0.0.1:3000/mcp")).toBe("127.0.0.1:3000");
    expect(openConnectorHost("  https://connector.example.com/mcp ")).toBe("connector.example.com");
    expect(openConnectorHost("garbage")).toBe("garbage");
  });
});

describe("isLoopbackAddress", () => {
  it("knows the loopback names", () => {
    expect(isLoopbackAddress("http://127.0.0.1:3000/mcp")).toBe(true);
    expect(isLoopbackAddress("http://localhost:3000/mcp")).toBe(true);
    expect(isLoopbackAddress("http://[::1]:3000/mcp")).toBe(true);
    expect(isLoopbackAddress("https://connector.example.com/mcp")).toBe(false);
    expect(isLoopbackAddress("garbage")).toBe(false);
  });
});
