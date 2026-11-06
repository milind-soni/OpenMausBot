import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkFraming, framingOf } from "./web-panel-framing.ts";

const APP = "http://127.0.0.1:8799";
const PAGE = "https://www.globo.com/";

describe("framingOf", () => {
  it("lets a page with neither header be framed", () => {
    expect(framingOf({}, PAGE, APP)).toBe("allowed");
  });

  it("follows X-Frame-Options as browsers do", () => {
    expect(framingOf({ "x-frame-options": "DENY" }, PAGE, APP)).toBe("blocked");
    expect(framingOf({ "x-frame-options": " sameorigin " }, PAGE, APP)).toBe("blocked");
    expect(framingOf({ "x-frame-options": "SAMEORIGIN" }, "http://127.0.0.1:8799/x", APP)).toBe("allowed");
    expect(framingOf({ "x-frame-options": "ALLOWALL" }, PAGE, APP)).toBe("allowed");
    expect(framingOf({ "x-frame-options": "ALLOW-FROM https://a.example" }, PAGE, APP)).toBe("allowed");
    expect(framingOf({ "x-frame-options": "DENY, SAMEORIGIN" }, PAGE, APP)).toBe("blocked");
    expect(framingOf({ "x-frame-options": "nonsense, other" }, PAGE, APP)).toBe("allowed");
  });

  it("reads Globo's frame-ancestors as refusing the app", () => {
    const csp = "frame-ancestors 'self' https://*.globo.com https://*.globoi.com https://*.i.globo https://*.techtudo.com.br always";
    expect(framingOf({ "content-security-policy": csp }, PAGE, APP)).toBe("blocked");
  });

  it("lets frame-ancestors override X-Frame-Options", () => {
    expect(framingOf({ "x-frame-options": "DENY", "content-security-policy": "frame-ancestors *" }, PAGE, APP)).toBe("allowed");
  });

  it("matches the app origin against each frame-ancestors source", () => {
    const verdict = (sources: string, app = APP) => framingOf({ "content-security-policy": `default-src 'self'; frame-ancestors ${sources}` }, PAGE, app);
    expect(verdict("'none'")).toBe("blocked");
    expect(verdict("'self'")).toBe("blocked");
    expect(verdict("*")).toBe("allowed");
    expect(verdict("http:")).toBe("allowed");
    expect(verdict("https:")).toBe("blocked");
    expect(verdict("http:", "https://omb.example.com")).toBe("allowed");
    expect(verdict("http://127.0.0.1:8799")).toBe("allowed");
    expect(verdict("http://127.0.0.1:*")).toBe("allowed");
    expect(verdict("http://127.0.0.1")).toBe("blocked");
    expect(verdict("127.0.0.1:8799")).toBe("blocked");
    expect(verdict("omb.example.com", "https://omb.example.com")).toBe("allowed");
    expect(verdict("*.example.com", "https://omb.example.com")).toBe("allowed");
    expect(verdict("*.example.com", "https://example.com")).toBe("blocked");
    expect(verdict("https://OMB.example.com/", "https://omb.example.com")).toBe("allowed");
    expect(verdict("https://omb.example.com:443", "https://omb.example.com")).toBe("allowed");
    expect(verdict("http://omb.example.com:80", "https://omb.example.com")).toBe("unknown");
    expect(framingOf({ "content-security-policy": "frame-ancestors; default-src *" }, PAGE, APP)).toBe("blocked");
    expect(verdict("'nonce-abc' 'unsafe-inline'")).toBe("blocked");
  });

  it("says unknown rather than blocked when it cannot read a source", () => {
    const verdict = (sources: string) => framingOf({ "content-security-policy": `frame-ancestors ${sources}` }, PAGE, APP);
    expect(verdict("http://127.0.0.1:8799/only/this")).toBe("unknown");
    expect(verdict("https://a.example/only/this")).toBe("blocked");
    expect(verdict("https://a.example %%")).toBe("unknown");
  });

  it("blocks when any one of several policies refuses, and ignores report-only", () => {
    expect(framingOf({ "content-security-policy": "frame-ancestors *, frame-ancestors 'none'" }, PAGE, APP)).toBe("blocked");
    expect(framingOf({ "content-security-policy-report-only": "frame-ancestors 'none'" }, PAGE, APP)).toBe("allowed");
  });
});

describe("checkFraming", () => {
  let server: Server;
  let port = 0;
  const test = {
    lookup: async (host: string) => (host === "panel.test" ? [{ address: "127.0.0.1", family: 4 }] : []),
    allow: ({ host }: { host: string }) => host === "panel.test",
  };
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/deny") res.writeHead(200, { "x-frame-options": "DENY" }).end("no");
      else if (req.url === "/hop") res.writeHead(302, { location: "/deny" }).end();
      else if (req.url === "/ok") res.writeHead(200).end("yes");
      else res.writeHead(404).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("reads the headers of the page itself", async () => {
    expect(await checkFraming(`http://panel.test:${port}/deny`, APP, test)).toBe("blocked");
    expect(await checkFraming(`http://panel.test:${port}/ok`, APP, test)).toBe("allowed");
  });

  it("can't tell from a redirect, which may lead to a sign-in page the person's browser never gets", async () => {
    expect(await checkFraming(`http://panel.test:${port}/hop`, APP, test)).toBe("unknown");
  });

  it("can't tell for a page it may not or could not reach", async () => {
    expect(await checkFraming(`http://127.0.0.1:${port}/deny`, APP)).toBe("unknown");
    expect(await checkFraming(`http://panel.test:${port}/missing`, APP, test)).toBe("unknown");
    expect(await checkFraming("not a url", APP, test)).toBe("unknown");
  });
});
