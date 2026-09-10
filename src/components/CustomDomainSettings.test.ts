import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CustomDomainDnsRecord, customDomainDnsName, CustomDomainGuide, customDomainProxyExample, type CustomDomainStatus } from "./CustomDomainSettings";

const status: CustomDomainStatus = {
  publicUrl: "https://old.example.com",
  customDomain: null,
  fallbackUrl: "https://old.example.com",
  supported: true,
  appPort: 23456,
  webhookPort: 23457,
  serverIpv4: "8.8.8.8",
};

describe("custom domain setup guidance", () => {
  it("uses this server's ports and leaves both app and hooks on loopback", () => {
    const config = customDomainProxyExample(status);
    expect(config).toContain("reverse_proxy 127.0.0.1:23456");
    expect(config).toContain("reverse_proxy 127.0.0.1:23457");
    expect(config).toContain("handle /hooks/*");
    expect(config).toContain("flush_interval -1");
    expect(config).not.toContain("0.0.0.0");
  });

  it("explains DNS and HTTPS are configured separately before verification", () => {
    const html = renderToStaticMarkup(createElement(CustomDomainGuide, { status }));
    expect(html).toContain("A record");
    expect(html).toContain("AAAA");
    expect(html).toContain("administrator must configure HTTPS");
    expect(html).toContain("exact workspace before saving");
    expect(html).toContain("Never publish the app");
    expect(html).toContain("bots.example.com");
    expect(html).not.toContain(status.publicUrl!);
    expect(html).toContain("Advanced server setup");
    expect(html).not.toMatch(/<details[^>]*\bopen/);
  });
});

describe("copyable DNS record", () => {
  it.each([
    ["bots.company.com", "bots.company.com"],
    [" https://BOTS.company.com/ ", "bots.company.com"],
    ["https://bots.company.com:443", "bots.company.com"],
    ["company.co.uk", "company.co.uk"],
    ["bots.eu.company.co.uk", "bots.eu.company.co.uk"],
    ["böts.company.com", "xn--bts-sna.company.com"],
  ])("uses a complete DNS name for %s without guessing the provider's zone", (input, expected) => {
    expect(customDomainDnsName(input)).toBe(expected);
  });

  it.each(["", "http://bots.company.com", "https://bots.company.com:8443", "127.0.0.1", "https://[::1]", "2130706433", "bots..company.com", "localhost", "bots.internal", "https://user:secret@bots.company.com", "bots.company.com/pair#code=SECRET", "bots.company.com?key=SECRET", "bots.company.com\\@evil.com"])("does not present a DNS record for %s", (domain) => {
    expect(customDomainDnsName(domain)).toBeNull();
    const html = renderToStaticMarkup(createElement(CustomDomainDnsRecord, { domain, serverIpv4: status.serverIpv4 }));
    expect(html).not.toContain("Copy ");
    expect(html).not.toContain("SECRET");
  });

  it("shows the three copyable values with non-submitting, labeled buttons", () => {
    const html = renderToStaticMarkup(createElement(CustomDomainDnsRecord, { domain: "https://bots.company.com", serverIpv4: status.serverIpv4 }));
    expect(html).toContain("Type");
    expect(html).toContain("Name / Host");
    expect(html).toContain("Value / IP");
    expect(html).toContain("bots.company.com");
    expect(html).toContain("8.8.8.8");
    expect(html).toContain('aria-label="Copy Type"');
    expect(html).toContain('aria-label="Copy Name / Host"');
    expect(html).toContain('aria-label="Copy Value / IP"');
    expect(html.match(/type="button"/g)).toHaveLength(3);
    expect(html).not.toContain("reverse_proxy");
    expect(html).not.toContain("https://bots.company.com");
  });

  it("never substitutes the tunnel address or a placeholder for a missing server IP", () => {
    const html = renderToStaticMarkup(createElement(CustomDomainDnsRecord, { domain: "bots.company.com" }));
    expect(html).toContain("Ask your server administrator");
    expect(html).not.toContain('aria-label="Copy Value / IP"');
    expect(html).not.toContain("127.0.0.1");
  });
});
