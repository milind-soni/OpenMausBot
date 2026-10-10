// Helpers and server rendering cover translated copy and identity preservation.
// Mounted locale changes also need to preserve each panel's in-progress state.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { locales } from "@/locales";
import {
  connectedInventoryCopy,
  connectorActionLabel,
  disconnectAccountConfirmation,
} from "./PluginsPanel";
import { parseMcpEnvironment } from "./McpServersPanel";
import { ConnectorCard } from "./ConnectorCard";

afterEach(() => {
  setLocale("en");
});

describe("plugins modal translation", () => {
  it("translates the account action label in every pack", () => {
    const state = {
      busy: false,
      included: false,
      canContinue: false,
      hasAccounts: true,
      failed: false,
    };
    for (const [code, pack] of Object.entries(locales)) {
      setLocale(code);
      expect(connectorActionLabel("ready", state), code).toBe(pack["connectors.action.addAccount"]);
      expect(connectedInventoryCopy("error").title, code).toBe(pack["connectors.empty.errorTitle"]);
    }
  });

  it("keeps the account identity verbatim inside the translated confirmation", () => {
    setLocale("pt-br");
    const confirmation = disconnectAccountConfirmation("Gmail", { id: "ca_work", alias: "work" });
    expect(confirmation).toContain("“work” (ca_work)");
    expect(confirmation).toBe(
      t("connectors.disconnectConfirm", { identity: "“work” (ca_work)", service: "Gmail" }),
    );
    expect(confirmation).not.toContain("Disconnect");
  });

  it("translates an MCP environment parse error without touching the offending line", () => {
    setLocale("de");
    expect(parseMcpEnvironment("NOT A KEY=value")).toEqual({
      ok: false,
      error: { key: "mcp.env.invalidName", params: { key: "NOT A KEY" } },
    });
  });

  it("translates the in-chat connector card", () => {
    setLocale("ja");
    const html = renderToStaticMarkup(createElement(ConnectorCard, {
      botId: "atlas",
      threadId: "thread",
      message: {
        id: "m1",
        role: "bot",
        kind: "connector",
        at: 1,
        connector: { slug: "gmail", label: "Gmail", description: "Read mail", status: "required", resumeKey: "resume1" },
      },
    }));
    expect(html).toContain(locales.ja!["connectors.card.connectSecurely"]);
    expect(html).toContain(locales.ja!["connectors.card.requested"]);
    expect(html).not.toContain("Connect securely");
  });
});
