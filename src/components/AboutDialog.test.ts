import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appVersion } from "@/lib/app-links";
import { setLocale } from "@/lib/i18n";
import { AboutDialog, aboutVersionLines } from "./AboutDialog";

function about(page: object): string {
  vi.stubGlobal("window", page);
  return renderToStaticMarkup(createElement(AboutDialog, { open: true, onClose: () => {} }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("About", () => {
  it("in the app on this computer, shows the app's own version on one line", () => {
    const html = about({ ogb: { platform: "darwin", app: { version: "0.1.127", ownPage: true } }, location: { host: "127.0.0.1:8799" } });
    expect(html).toContain(">Version 0.1.127 · macOS</p>");
    expect(html).not.toContain("Connected to");
  });

  it("in the app on another server, shows the app's own version and names that server with the version it runs", () => {
    const html = about({ ogb: { platform: "darwin", app: { version: "0.1.127", ownPage: false } }, location: { host: "bots.example.test" } });
    expect(html).toContain(">Version 0.1.127 · macOS</p>");
    expect(html).toContain(`>Connected to bots.example.test · version ${appVersion()}</p>`);
  });

  it("in a browser, keeps the page's version on one line", () => {
    const html = about({ location: { host: "bots.example.test" } });
    expect(html).toContain(`>Version ${appVersion()}</p>`);
    expect(html).not.toContain("Connected to");
  });

  it("in an app too old to say which version it is, keeps the page's version as before", () => {
    const html = about({ ogb: { platform: "darwin" }, location: { host: "bots.example.test" } });
    expect(html).toContain(`>Version ${appVersion()} · macOS</p>`);
    expect(html).not.toContain("Connected to");
  });

  it("names the server as it was saved, in the person's language", () => {
    const app = { version: "0.1.127", ownPage: false };
    expect(aboutVersionLines({ app, bundle: "0.1.116", platform: "macOS", server: "Office Mac" })).toEqual([
      "Version 0.1.127 · macOS",
      "Connected to Office Mac · version 0.1.116",
    ]);
    setLocale("de");
    expect(aboutVersionLines({ app, bundle: "0.1.116", platform: "macOS", server: "Office Mac" })).toEqual([
      "Version 0.1.127 · macOS",
      "Verbunden mit Office Mac · Version 0.1.116",
    ]);
  });
});
