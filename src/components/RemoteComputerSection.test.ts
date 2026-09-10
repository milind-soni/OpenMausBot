import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { isServerPairingLink, RemoteComputerSection } from "./RemoteComputerSection";

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("self-hosted server pairing links", () => {
  it.each([
    "https://bots.example.com/pair#code=ABCD-EFGH-JKLM",
    " https://custom.example.com:8443/pair/#code=ABCD%2DEFGH%2DJKLM ",
    "https://random.trycloudflare.com/pair#code=ABCDEFGHJKLM",
  ])("accepts a complete custom HTTPS link: %s", (link) => {
    expect(isServerPairingLink(link)).toBe(true);
  });

  it.each([
    "",
    "ABCD-EFGH-JKLM",
    "http://bots.example.com/pair#code=ABCD-EFGH-JKLM",
    "https:example.com/pair#code=ABCD-EFGH-JKLM",
    "https://user:secret@bots.example.com/pair#code=ABCD-EFGH-JKLM",
    "https://bots.example.com",
    "https://bots.example.com/pair",
    "https://bots.example.com/pair#code=",
    "https://bots.example.com/pair#code=%20",
    "https://bots.example.com/pair#code=%",
    "https://bots.example.com/other#code=ABCD-EFGH-JKLM",
    "https://bots.example.com/pair?code=ABCD-EFGH-JKLM",
    "https://bots.example.com/pair?code=secret#code=ABCD-EFGH-JKLM",
    "https://bots.example.com/pair#code=ABCD EFGH JKLM",
    "https://bots.example.com\\@other.example/pair#code=ABCD-EFGH-JKLM",
    "openmausbot://pair?code=123456",
  ])("rejects an incomplete, malformed, or insecure link: %s", (link) => {
    expect(isServerPairingLink(link)).toBe(false);
  });
});

describe("remote connection Settings", () => {
  const render = (ogb?: unknown) => {
    vi.stubGlobal("window", { ogb });
    setLocale("en");
    return renderToStaticMarkup(createElement(RemoteComputerSection));
  };
  const environments = { addFromLink: vi.fn() };

  it("defaults to server pairing and explains how to obtain a fresh full link", () => {
    const html = render({ environments, remoteClient: { active: false } });
    expect(html).toContain('<option value="server" selected="">Self-hosted server</option>');
    expect(html).toContain('<option value="companion">Desktop companion</option>');
    expect(html).toContain("Server pairing link");
    expect(html).toContain("npx openmausbot pair --client");
    expect(html).toContain("12-character code");
    expect(html).toContain("custom domains and Cloudflare Tunnel");
    expect(html).toContain("Connect to server");
    expect(html).toContain("Server menu");
    expect(html).not.toContain('placeholder="000000"');
    expect(environments.addFromLink).not.toHaveBeenCalled();
  });

  it("allows a server-only bridge without presenting a companion option", () => {
    const html = render({ environments });
    expect(html).toContain("Server pairing link");
    expect(html).not.toContain("<select");
  });

  it("preserves six-digit companion pairing when the server bridge is unavailable", () => {
    const html = render({ remoteClient: { active: false } });
    expect(html).toContain("Companion address");
    expect(html).toContain("Six-digit companion code");
    expect(html).toContain('placeholder="000000"');
    expect(html).toContain("managed OpenMausBot HTTPS address");
    expect(html).toContain("Tailscale name ending in .ts.net");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Server pairing link");
  });

  it("keeps an active companion connection on its disconnect screen", () => {
    const html = render({ environments, remoteClient: { active: true } });
    expect(html).toContain("Disconnect and use this computer");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<select");
  });

  it.each([undefined, { platform: "darwin" }])("hides unavailable actions on browser and remote server pages", (bridge) => {
    const html = render(bridge);
    expect(html).toContain("requires the installed app");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });
});
