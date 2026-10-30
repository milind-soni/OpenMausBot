import { describe, expect, it } from "vitest";

import { POSTIZ_CLOUD } from "../../shared/postiz.ts";
import { postizAddress, postizCloud, postizEntryMethod, postizKeyHeaders, postizKeyUrl, postizSignInUrl } from "./connection.ts";

const desktop = { loopback: true }, cloud = { loopback: false };
const entry = (url: string, headers: Record<string, string> = {}) => ({ type: "http" as const, url, headers, enabled: true });

describe("postizAddress", () => {
  it("is Postiz Cloud when left empty", () => {
    expect(postizAddress("", desktop)).toEqual({ ok: true, address: POSTIZ_CLOUD });
    expect(postizAddress(undefined, cloud)).toEqual({ ok: true, address: POSTIZ_CLOUD });
  });

  it("keeps a self-hosted server's path and drops a trailing slash or a pasted MCP endpoint", () => {
    expect(postizAddress(" https://postiz.example.com/api/ ", cloud)).toEqual({ ok: true, address: "https://postiz.example.com/api" });
    expect(postizAddress("https://postiz.example.com/api/mcp", cloud)).toEqual({ ok: true, address: "https://postiz.example.com/api" });
    expect(postizAddress("https://api.postiz.com/mcp-oauth-dynamic", cloud)).toEqual({ ok: true, address: "https://api.postiz.com" });
    expect(postizAddress("https://postiz.example.com:8443", cloud)).toEqual({ ok: true, address: "https://postiz.example.com:8443" });
  });

  it("takes plain http only for a Postiz on this computer, and never on a Cloud", () => {
    expect(postizAddress("http://127.0.0.1:5000", desktop)).toEqual({ ok: true, address: "http://127.0.0.1:5000" });
    expect(postizAddress("http://localhost:3000/api", desktop)).toEqual({ ok: true, address: "http://localhost:3000/api" });
    expect(postizAddress("http://[::1]:5000", desktop)).toEqual({ ok: true, address: "http://[::1]:5000" });
    expect(postizAddress("http://postiz.example.com", desktop)).toMatchObject({ ok: false, error: expect.stringContaining("https://") });
    expect(postizAddress("http://127.0.0.1:5000", cloud)).toMatchObject({ ok: false, error: "Use your Postiz server's https:// address." });
  });

  it("refuses credentials, a key in the path, query strings and other schemes", () => {
    expect(postizAddress("https://user:pass@postiz.example.com", cloud)).toMatchObject({ ok: false, error: expect.stringContaining("password") });
    expect(postizAddress("https://mcp.postiz.com/mcp/abc123", cloud)).toMatchObject({ ok: false, error: expect.stringContaining("has a key in it") });
    expect(postizAddress("https://postiz.example.com/?key=abc", cloud)).toMatchObject({ ok: false });
    expect(postizAddress("https://postiz.example.com/#x", cloud)).toMatchObject({ ok: false });
    expect(postizAddress("ftp://postiz.example.com", cloud)).toMatchObject({ ok: false });
    expect(postizAddress("postiz.example.com", cloud)).toMatchObject({ ok: false });
  });
});

describe("postizCloud", () => {
  it("is api.postiz.com unless a test server names a loopback or https stand-in", () => {
    expect(postizCloud({})).toBe("https://api.postiz.com");
    expect(postizCloud({ OMB_POSTIZ_CLOUD_URL: "http://127.0.0.1:4100" })).toBe("http://127.0.0.1:4100");
    expect(postizCloud({ OMB_POSTIZ_CLOUD_URL: "http://evil.example" })).toBe("https://api.postiz.com");
    expect(postizCloud({ OMB_POSTIZ_CLOUD_URL: "https://u:p@evil.example" })).toBe("https://api.postiz.com");
  });
});

describe("the postiz entry", () => {
  it("knows the card's own entries and nothing else", () => {
    expect(postizEntryMethod(entry(postizSignInUrl()), undefined)).toBe("sign-in");
    expect(postizEntryMethod(entry("https://api.postiz.com/mcp"), undefined)).toBe("key");
    expect(postizEntryMethod(entry("https://postiz.example.com/api/mcp"), { url: "https://postiz.example.com/api" })).toBe("key");
    expect(postizEntryMethod(entry("https://old.example.com/mcp"), { url: "https://postiz.example.com/api" })).toBe("old-key");
    expect(postizEntryMethod(entry("https://mcp.postiz.com/mcp/abc123"), undefined)).toBeNull();
    expect(postizEntryMethod(entry("https://api.postiz.com/mcp", { Authorization: "Bearer mine" }), undefined)).toBeNull();
    expect(postizEntryMethod({ ...entry(postizSignInUrl()), type: "sse" }, undefined)).toBeNull();
  });

  it("gets the saved key only at the address the key was saved for", () => {
    const saved = { key: " pz-key ", url: "https://postiz.example.com/api" };
    expect(postizKeyHeaders(saved, "postiz", { url: postizKeyUrl("https://postiz.example.com/api") })).toEqual({ Authorization: "Bearer pz-key" });
    expect(postizKeyHeaders(saved, "postiz", { url: "https://elsewhere.example.com/api/mcp" })).toEqual({});
    expect(postizKeyHeaders(saved, "postiz", { url: postizSignInUrl() })).toEqual({});
    expect(postizKeyHeaders(saved, "other", { url: postizKeyUrl("https://postiz.example.com/api") })).toEqual({});
    expect(postizKeyHeaders({ url: saved.url }, "postiz", { url: postizKeyUrl(saved.url) })).toEqual({});
    expect(postizKeyHeaders({ key: "k" }, "postiz", { url: "https://api.postiz.com/mcp" })).toEqual({ Authorization: "Bearer k" });
  });
});
