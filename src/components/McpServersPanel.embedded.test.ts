import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The server list is McpServersPanel's first piece of state; seed it as a
// finished load would leave it (effects do not run under server rendering).
const fixture = vi.hoisted(() => ({ servers: null as unknown, index: 0, counting: false, seeded: {} as Record<number, unknown> }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!fixture.counting) return react.useState(initial);
      const index = fixture.index++;
      if (index === 0) return [fixture.servers, () => {}];
      if (Object.hasOwn(fixture.seeded, index)) return [fixture.seeded[index], () => {}];
      return [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}];
    },
  };
});
vi.mock("@/state/store", () => ({
  api: vi.fn(() => new Promise(() => {})),
  useStore: () => ({ state: { config: null }, dispatch: vi.fn() }),
}));
import { McpServersPanel } from "./McpServersPanel";

function render(embedded: boolean, whopCard = false) {
  function Capture() {
    fixture.index = 0;
    fixture.counting = true;
    try { return McpServersPanel({ embedded, whopCard }); } finally { fixture.counting = false; }
  }
  return renderToStaticMarkup(createElement(Capture));
}

/** useState order in McpServersPanel: the server whose sign-in is open, then its flow. */
const SIGNING_IN = 7;
const SIGN_IN_FLOW = 8;

beforeEach(() => {
  vi.stubGlobal("window", {});
  fixture.seeded = {};
  fixture.servers = [
    { name: "notes", command: "npx", args: ["-y", "notes-mcp"], envKeys: [], enabled: true },
    { name: "docs", type: "http", url: "https://mcp.example.com/mcp", headerKeys: [], enabled: false },
  ];
});
afterEach(() => vi.unstubAllGlobals());

describe("Your MCP servers inside the Apps pop-up", () => {
  it("lists each server with Test, Edit and an on/off switch, plus Paste config and Add MCP server", () => {
    const html = render(true);
    expect(html).toContain("Your MCP servers");
    expect(html).toContain("Paste config");
    expect(html).toContain("Add MCP server");
    expect(html.match(/role="switch"/g)?.length).toBeGreaterThanOrEqual(3); // two servers + the Claude Code switch
    expect(html).toMatch(/aria-label="Turn notes off" type="button" role="switch" aria-checked="true"/);
    expect(html).toMatch(/aria-label="Turn docs on" type="button" role="switch" aria-checked="false"/);
    expect(html).toContain('aria-label="Edit notes"');
    expect(html.match(/> Test</g)).toHaveLength(2);
    // a section of the pop-up's own scroll, not a second scroller
    expect(html).not.toContain("overflow-y-auto");
  });

  it("keeps its own scroll and wording when shown on its own", () => {
    const html = render(false);
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("Add server");
  });

  it("offers Whop setup with no API key form or forced installation", () => {
    fixture.servers = [];
    const html = render(true, true);
    expect(html).toContain('data-app-tile="whop"');
    expect(html).toContain('aria-label="Connect Whop"');
    expect(html).toContain("no API key needed");
    expect(html).toContain("admin access across businesses");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Your MCP servers");
    expect(html).not.toContain("Paste config");
  });

  it("recognizes an existing Whop URL under any name and exposes access and disconnect", () => {
    fixture.servers = [{ name: "business", type: "http", url: "https://mcp.whop.com/mcp", headerKeys: [], enabled: true, auth: "signed-in" }];
    const html = render(true);
    expect(html).toContain('data-whop-server="business"');
    expect(html).toContain("Disconnect Whop");
    expect(html).toContain("Bot access");
    expect(html).not.toContain("data-whop-setup");
  });

  it("does not brand an unrelated endpoint just because its name is whop", () => {
    fixture.servers = [{ name: "whop", type: "http", url: "https://unrelated.example/mcp", headerKeys: [], enabled: false }];
    const html = render(true);
    expect(html).not.toContain("data-whop-setup");
    expect(html).not.toContain("data-whop-server");
  });

  it.each([true, false])("shows the paste step openly only when the browser cannot come back (pasteBack %s)", (pasteBack) => {
    fixture.servers = [{ name: "whop", type: "http", url: "https://mcp.whop.com/mcp", headerKeys: [], enabled: true, auth: "needs-sign-in" }];
    fixture.seeded = {
      [SIGNING_IN]: "whop",
      [SIGN_IN_FLOW]: { phase: "waiting", flowId: "00000000-0000-4000-8000-000000000000", authorizationUrl: "https://whop.example/authorize", ...(pasteBack ? { pasteBack } : {}) },
    };
    for (const html of [render(true, true), render(true)]) {
      expect(html).toContain('id="mcp-callback-whop"');
      if (pasteBack) {
        expect(html).toContain("your browser shows a page that can&#x27;t load. Copy that page&#x27;s full address and paste it here.");
        expect(html).not.toContain("Signing in from another computer?");
      } else {
        expect(html).toContain("<summary");
        expect(html).toContain("Signing in from another computer?");
        expect(html).not.toContain("a page that can&#x27;t load");
      }
    }
  });
});
