import { describe, expect, it } from "vitest";
import { isJsonContentType, isPreviewAssetRead, rejectUntrustedRequest } from "./request-guard.ts";

describe("rejectUntrustedRequest", () => {
  it("accepts the app's own page and non-browser local clients", () => {
    expect(
      rejectUntrustedRequest({ host: "127.0.0.1:8899", origin: "http://127.0.0.1:8899", "sec-fetch-site": "same-origin" }),
    ).toBeNull();
    expect(rejectUntrustedRequest({ host: "localhost:8899" })).toBeNull();
    expect(rejectUntrustedRequest({ host: "[::1]:8899" })).toBeNull();
  });

  it("refuses a DNS-rebinding or LAN Host unless LAN access was opted into", () => {
    expect(rejectUntrustedRequest({ host: "evil.example:8899" })).toMatch(/untrusted Host/);
    expect(rejectUntrustedRequest({ host: "192.168.1.20:8899" })).toMatch(/untrusted Host/);
    expect(rejectUntrustedRequest({ host: "192.168.1.20:8899" }, { allowAnyHost: true })).toBeNull();
    expect(rejectUntrustedRequest({})).toMatch(/missing Host/);
  });

  it("refuses cross-origin browser requests even on a loopback Host", () => {
    expect(rejectUntrustedRequest({ host: "127.0.0.1:8899", origin: "https://evil.example" })).toMatch(/cross-origin/);
    expect(rejectUntrustedRequest({ host: "127.0.0.1:8899", origin: "null" })).toMatch(/cross-origin/);
    expect(rejectUntrustedRequest({ host: "127.0.0.1:8899", origin: "http://127.0.0.1:5199" })).toMatch(/cross-origin/);
    expect(rejectUntrustedRequest({ host: "127.0.0.1:8899", "sec-fetch-site": "cross-site" })).toMatch(/cross-origin/);
    expect(
      rejectUntrustedRequest({ host: "192.168.1.20:8899", origin: "http://evil.example" }, { allowAnyHost: true }),
    ).toMatch(/cross-origin/);
  });
});

describe("isJsonContentType", () => {
  it("accepts JSON with or without parameters and nothing else", () => {
    expect(isJsonContentType({ "content-type": "application/json" })).toBe(true);
    expect(isJsonContentType({ "content-type": "application/json; charset=utf-8" })).toBe(true);
    expect(isJsonContentType({ "content-type": "text/plain" })).toBe(false);
    expect(isJsonContentType({ "content-type": "application/jsonp" })).toBe(false);
    expect(isJsonContentType({})).toBe(false);
  });
});


describe("isPreviewAssetRead", () => {
  const asset = `/api/preview/asset/${"a".repeat(64)}/project/`;
  it("permits only normalized capability asset GETs", () => {
    expect(isPreviewAssetRead("GET", `${asset}style.css?v=1`)).toBe(true);
    expect(isPreviewAssetRead("GET", `${asset}nested/../style.css`)).toBe(true);
    for (const method of ["POST", "HEAD", "DELETE", undefined]) {
      expect(isPreviewAssetRead(method, `${asset}style.css`)).toBe(false);
    }
  });
  it("refuses raw prefixes that normalize into privileged routes", () => {
    for (const segment of ["..", "%2e%2e", ".%2E", "%2e."]) {
      expect(isPreviewAssetRead("GET", `${asset}${Array(4).fill(segment).join("/")}/bots`)).toBe(false);
    }
    for (const url of [undefined, "//evil.example/api/preview/asset/", "http://localhost/api/bots", "/api/bots"]) {
      expect(isPreviewAssetRead("GET", url)).toBe(false);
    }
  });
});
