import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ config: undefined as import("@/state/store").ConfigStatus | undefined }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: "connections", instances: [], config: fixture.config }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));

beforeEach(() => {
  fixture.config = undefined;
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("Settings → Connections", () => {
  it.each(["router", "OpenRouter", "base URL", "API key", "OpenAI", "Anthropic", "Groq"])("is found by searching for %s", async (typed) => {
    const { fullContext, searchSettings } = await import("./settings/settings-index");
    const { t } = await import("@/lib/i18n");
    const hits = searchSettings(typed, fullContext(), (entry) => t(entry.labelKey), (page) => t(page.labelKey));
    expect(hits.some((hit) => hit.entry.page === "ai" && hit.entry.anchor === "ai-keys")).toBe(true);
  });

  it("points OpenCode users at `opencode auth login` for other providers", async () => {
    const { SettingsModal } = await import("./SettingsModal");
    const html = renderToStaticMarkup(createElement(SettingsModal));
    expect(html).toContain("More providers for OpenCode bots");
    expect(html).toContain('<code class="font-mono">opencode auth login</code>');
  });

  it("offers keys for other OpenCode providers next to the OpenCode key", async () => {
    const { SettingsModal } = await import("./SettingsModal");
    const html = renderToStaticMarkup(createElement(SettingsModal));
    const opencode = html.indexOf('data-api-key-row="opencodeGo"');
    expect(opencode).toBeGreaterThan(0);
    expect(html.indexOf("data-opencode-provider-keys")).toBeGreaterThan(opencode);
    expect(html).toContain("Keys for other OpenCode providers");
  });

  it("sends nobody on a Cloud to a terminal, only to the keys for other providers", async () => {
    const { configStatusFromFrame } = await import("@/state/store");
    fixture.config = configStatusFromFrame({
      composio: { configured: false },
      box: { configured: false },
      vps: { configured: false, sshAlias: "" },
      rooms: { turnTimeoutMinutes: 10 },
      mcp: { callTimeoutMinutes: 10 },
      localVm: { mode: "shared", maxInstances: 1 },
      cloudHome: true,
    });
    const { SettingsModal } = await import("./SettingsModal");
    const html = renderToStaticMarkup(createElement(SettingsModal));
    expect(html).toContain("OpenCode API key");
    expect(html).not.toContain("opencode auth login");
    expect(html).not.toContain("More providers for OpenCode bots");
    expect(html).toContain("Keys for other OpenCode providers");
  });
});
