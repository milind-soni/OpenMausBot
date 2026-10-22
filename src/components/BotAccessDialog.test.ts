import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  bots: [] as unknown[],
  ownerOrAdmin: true as boolean | null,
}));

vi.mock("react-dom", async (original) => ({ ...await original<object>(), createPortal: (children: unknown) => children }));
vi.stubGlobal("document", { body: {} });
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("./bot-settings/useBotApps", () => ({
  useConnectedApps: () => ({
    phase: "ready",
    connectedSlugs: ["github", "supabase"],
    apps: [
      { slug: "github", label: "GitHub", blurb: "", card: { logo: null, domain: null, label: "GitHub" }, scope: "write" },
      { slug: "supabase", label: "Supabase", blurb: "", card: { logo: null, domain: null, label: "Supabase" }, scope: "write" },
    ],
  }),
}));
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  desktopApprovalBridge: () => undefined,
  persistBotUpdate: vi.fn(),
  useStore: () => ({
    state: {
      bots: fixture.bots,
      instances: [{
        instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", enabled: true,
        snapshot: { state: "available" }, models: { default: "m", options: [] }, capabilities: { composioMcp: true },
      }],
    },
    dispatch: vi.fn(),
  }),
}));

import { BotAccessDialog } from "./BotAccessDialog";

const bot = (id: string, fields: Record<string, unknown> = {}) => ({
  id, threadId: `${id}-t`, name: id, title: "", description: "", notifications: true, color: "blue", unread: false,
  modelSelection: { instanceId: "claude", model: "m" }, ...fields,
});

const render = () => renderToStaticMarkup(createElement(BotAccessDialog, { onClose: () => {} }));

describe("Bot access page", () => {
  it("shows a row per visible bot with each connected app, its approval level and its sending rule", () => {
    fixture.bots = [
      bot("Rigel", { connectorTools: { supabase: { tools: "*" } } }),
      bot("Atlas", { composio: false }),
      bot("Ghost", { hidden: true }),
    ];
    fixture.ownerOrAdmin = true;
    const html = render();
    expect(html).toContain("Bot access");
    expect(html).toContain("GitHub");
    expect(html).toContain("Supabase");
    expect(html).toContain('data-bot-id="Rigel"');
    expect(html).toContain('data-bot-id="Atlas"');
    expect(html).not.toContain('data-bot-id="Ghost"');
    expect(html).toContain("Rigel&#x27;s access to GitHub");
    expect(html).toContain("Approval level");
    expect(html).toContain("Sending on your behalf");
    expect(html).toContain("Copy to all");
    expect(html).not.toContain("Only the owner or an admin");
  });

  it("still renders when a bot's grants were saved in a shape this build cannot read", () => {
    fixture.bots = [bot("Odd", { connectorTools: { github: { tools: null }, supabase: "everything" } }), bot("Fine")];
    fixture.ownerOrAdmin = true;
    const html = render();
    expect(html).toContain('data-bot-id="Odd"');
    expect(html).toContain("Custom");
    expect(html).toContain('data-bot-id="Fine"');
  });

  it("is read-only for someone who is not the owner or an admin", () => {
    fixture.bots = [bot("Rigel")];
    fixture.ownerOrAdmin = false;
    const html = render();
    expect(html).toContain("Only the owner or an admin can change bot access.");
    expect(html).toMatch(/<select[^>]*disabled/);
  });
});
