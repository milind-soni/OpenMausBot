import { describe, expect, it } from "vitest";

import { baseDomain, discoverMailServers, parseAutoconfig, smtpBeside, type DiscoverDeps } from "./discover.ts";

const AUTOCONFIG = `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="x">
  <incomingServer type="pop3"><hostname>pop.example.com</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
  <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
  <incomingServer type="imap"><hostname>plain.example.com</hostname><port>143</port><socketType>plain</socketType></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username></outgoingServer>
</emailProvider></clientConfig>`;

function deps(over: Partial<DiscoverDeps> & { pages?: Record<string, string> } = {}): DiscoverDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetchText: over.fetchText ?? (async (url) => { asked.push(url); return over.pages?.[url] ?? null; }),
    mx: over.mx ?? (async () => []),
    srv: over.srv ?? (async () => []),
    cname: over.cname ?? (async () => []),
    reverse: over.reverse ?? (async () => []),
  };
}

describe("where a mailbox's servers are", () => {
  it("reads a provider's autoconfig file, TLS only, keeping which name signs in", () => {
    expect(parseAutoconfig(AUTOCONFIG, "shop.example")).toEqual({
      imap: [{ host: "imap.shop.example", port: 993, secure: true }],
      smtp: [{ host: "smtp.example.com", port: 587, secure: false }],
      username: "address",
    });
  });

  it("never offers a host that isn't one, whatever a file says", () => {
    const bad = AUTOCONFIG.replace("imap.%EMAILDOMAIN%", "evil host;rm -rf").replace("smtp.example.com", "localhost");
    expect(parseAutoconfig(bad, "shop.example")).toMatchObject({ imap: [], smtp: [] });
  });

  it("the domain's own file comes first, and asks Thunderbird's list by domain", async () => {
    const found = await discoverMailServers("me@shop.example", deps({ pages: { "https://autoconfig.shop.example/mail/config-v1.1.xml": AUTOCONFIG } }));
    expect(found.imap[0]).toEqual({ host: "imap.shop.example", port: 993, secure: true });
    expect(found.smtp[0]).toEqual({ host: "smtp.example.com", port: 587, secure: false });
    const asking = deps();
    await discoverMailServers("me@shop.example", asking);
    expect(asking.asked).toEqual(expect.arrayContaining(["https://autoconfig.shop.example/mail/config-v1.1.xml", "https://shop.example/.well-known/autoconfig/mail/config-v1.1.xml", "https://autoconfig.thunderbird.net/v1.1/shop.example"]));
  });

  it("knows a provider from the MX record of a domain on it, ahead of guesses", async () => {
    const found = await discoverMailServers("office@small-shop.at", deps({ mx: async () => ["mx1.world4you.com."] }));
    expect(found.imap[0]).toEqual({ host: "imap.world4you.com", port: 993, secure: true });
    expect(found.smtp[0]).toEqual({ host: "smtp.world4you.com", port: 587, secure: false });
  });

  it("a domain hosted at a provider under its own names: the provider's servers, found from the names behind them", async () => {
    // How a World4You domain looks: its MX is mail.<the domain> on World4You's address, imap.<the domain> is a CNAME to
    // imap.world4you.com, and World4You's certificates are for *.world4you.com only.
    const found = await discoverMailServers("office@small-shop.at", deps({
      mx: async () => ["mail.small-shop.at."],
      cname: async (name) => (name === "imap.small-shop.at" ? ["imap.world4you.com"] : []),
      reverse: async (host) => (host === "mail.small-shop.at" ? ["mail25.world4you.com"] : []),
    }));
    expect(found.imap[0]).toEqual({ host: "imap.world4you.com", port: 993, secure: true });
    expect(found.smtp[0]).toEqual({ host: "smtp.world4you.com", port: 587, secure: false });
  });

  it("the same domain known only by its MX's reverse name", async () => {
    const found = await discoverMailServers("office@small-shop.at", deps({ mx: async () => ["mail.small-shop.at."], reverse: async () => ["mail25.world4you.com."] }));
    expect(found.smtp[0]).toEqual({ host: "smtp.world4you.com", port: 587, secure: false });
  });

  it("knows Easyname, whose outgoing server takes TLS on 465", async () => {
    const found = await discoverMailServers("office@small-shop.at", deps({ mx: async () => ["mx01.easyname.com."] }));
    expect(found.imap[0]).toEqual({ host: "imap.easyname.com", port: 993, secure: true });
    expect(found.smtp.slice(0, 2)).toEqual([{ host: "smtp.easyname.com", port: 465, secure: true }, { host: "smtp.easyname.com", port: 587, secure: false }]);
  });

  it("the outgoing server beside an incoming one: smtp.x and mail.x for imap.x or pop.x, on both ports", () => {
    expect(smtpBeside("imap.wh20.easyname.systems").map((server) => `${server.host}:${server.port}`)).toEqual([
      "smtp.wh20.easyname.systems:587", "smtp.wh20.easyname.systems:465", "mail.wh20.easyname.systems:587", "mail.wh20.easyname.systems:465",
      "imap.wh20.easyname.systems:587", "imap.wh20.easyname.systems:465",
    ]);
    expect(smtpBeside("pop.world4you.com")[0]).toEqual({ host: "smtp.world4you.com", port: 587, secure: false });
    expect(smtpBeside("mail.example.com").map((server) => server.host)).toEqual(["smtp.example.com", "smtp.example.com", "mail.example.com", "mail.example.com"]);
    expect(smtpBeside("imap.com").map((server) => server.host), "never a bare top-level name").not.toContain("smtp.com");
  });

  it("Gmail and Outlook come with what they need instead of a password", async () => {
    expect((await discoverMailServers("me@gmail.com", deps())).provider).toEqual({ rule: "app-password", hint: { provider: "Google", app: "gmail", appPasswordUrl: "https://myaccount.google.com/apppasswords" } });
    expect((await discoverMailServers("me@company.example", deps({ mx: async () => ["company-example.mail.protection.outlook.com."] }))).provider).toMatchObject({ rule: "no-password", hint: { app: "outlook" } });
  });

  it("asks Thunderbird's list about the provider behind an MX record it doesn't know", async () => {
    const asking = deps({ mx: async () => ["mx.hoster.example."], pages: { "https://autoconfig.thunderbird.net/v1.1/hoster.example": AUTOCONFIG } });
    const found = await discoverMailServers("me@shop.example", asking);
    expect(found.imap[0]!.host).toBe("imap.shop.example");
  });

  it("uses SRV records, then the usual names, each host and port once", async () => {
    const found = await discoverMailServers("me@shop.example", deps({
      mx: async () => ["mx.hoster.example."],
      srv: async (name) => (name === "_imaps._tcp.shop.example" ? [{ name: "post.shop.example", port: 993 }] : name === "_submission._tcp.shop.example" ? [{ name: "out.shop.example", port: 587 }] : []),
    }));
    expect(found.imap.slice(0, 3).map((server) => `${server.host}:${server.port}`)).toEqual(["post.shop.example:993", "imap.shop.example:993", "imap.shop.example:143"]);
    expect(found.smtp[0]).toEqual({ host: "out.shop.example", port: 587, secure: false });
    expect(found.imap.map((server) => server.host)).toEqual(expect.arrayContaining(["mail.shop.example", "imap.hoster.example", "mail.hoster.example"]));
    expect(new Set(found.imap.map((server) => `${server.host}:${server.port}`)).size).toBe(found.imap.length);
  });

  it("a guess is always a TLS place: the IMAP ports with TLS or STARTTLS, never a plain send", async () => {
    const found = await discoverMailServers("me@shop.example", deps());
    expect(found.imap).toContainEqual({ host: "imap.shop.example", port: 993, secure: true });
    expect(found.imap).toContainEqual({ host: "imap.shop.example", port: 143, secure: false });
    expect(found.smtp).toContainEqual({ host: "smtp.shop.example", port: 587, secure: false });
    expect(found.smtp).toContainEqual({ host: "smtp.shop.example", port: 465, secure: true });
  });

  it("finds nothing for what isn't a domain, and asks nobody", async () => {
    const asking = deps();
    expect(await discoverMailServers("me@localhost", asking)).toEqual({ imap: [], smtp: [] });
    expect(asking.asked).toEqual([]);
  });

  it("takes the registrable part of an MX host", () => {
    expect(baseDomain("mx3.mail.example.co.uk.")).toBe("example.co.uk");
    expect(baseDomain("mx1.world4you.com")).toBe("world4you.com");
    expect(baseDomain("mail.provider.at")).toBe("provider.at");
  });
});
