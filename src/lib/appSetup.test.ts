import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppSetupDialog } from "../components/AppSetupDialog";
import { StoreProvider } from "../state/store";
import { type AppInfo } from "../state/apps";
import { findApp } from "../../server/apps/catalog";

function markup(id: string) {
  const definition = findApp(id)!;
  const app: AppInfo = {
    ...definition,
    settings: { endpoint: definition.defaultEndpoint, customEndpoint: false, tokenConfigured: false },
    status: { state: "not_running", message: "Not running", toolCount: 0, checkedAt: 0 },
  };
  return renderToStaticMarkup(createElement(StoreProvider, { children: createElement(AppSetupDialog, { app, onClose() {} }) }));
}

describe("app setup authentication", () => {
  it("lets Affinity test its connection without a credential field or a misleading disconnect button", () => {
    const html = markup("affinity");
    expect(html).toContain('/apps/affinity.png');
    expect(html).toContain("No access token is needed");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Disconnect");
    expect(html.match(/<button[^>]*>Test connection<\/button>/)?.[0]).not.toMatch(/\sdisabled(?:=|[ >])/);
    expect(html).toMatch(/>Done<\/button>/);
  });

  it("still requires the Edits token before testing a new connection", () => {
    const html = markup("edits");
    expect(html).toContain('type="password"');
    expect(html).toContain("Access token");
    expect(html.match(/<button[^>]*>Test connection<\/button>/)?.[0]).toMatch(/\sdisabled(?:=|[ >])/);
  });
});
