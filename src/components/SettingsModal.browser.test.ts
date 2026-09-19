// Settings → Experimental → Bot browser. Static markup only — effects do not
// run here, so the card is pinned with a pre-configured path and the save
// write is pinned through the config PUT it would issue.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import { SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  section: "experimental" as AppSettingsSection,
  chromePath: "" as string,
  dispatch: vi.fn(),
  api: vi.fn(),
}));

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: fixture.api,
  useStore: () => ({
    state: {
      appSettingsSection: fixture.section,
      config: {
        browser: fixture.chromePath ? { chromePath: fixture.chromePath } : undefined,
        features: { browser: true, skillAuthoring: false },
        browserProfiles: [],
      },
    },
    dispatch: fixture.dispatch,
  }),
}));

vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "experimental";
  fixture.chromePath = "";
  vi.stubGlobal("window", { ogb: { platform: "win32" } });
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));

describe("Settings → Bot browser", () => {
  it("offers the path to the machine's own Chrome with the managed default", () => {
    const html = render();
    expect(html).toContain("Bot browser");
    expect(html).toContain("%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe");
    expect(html).toContain("Bots browse in their own profile either way");
  });

  it("keeps a configured path visible for editing", () => {
    fixture.chromePath = "C:\\Chrome\\chrome.exe";
    const html = render();
    expect(html).toContain("C:\\Chrome\\chrome.exe");
    expect(html).toContain("managed browser is used until it does");
  });

  it("does not mention the fallback note twice when nothing is configured", () => {
    const html = render();
    // The hint (with the fallback sentence) appears exactly once.
    expect(html.match(/managed browser is used until it does/g)).toHaveLength(1);
  });
});
