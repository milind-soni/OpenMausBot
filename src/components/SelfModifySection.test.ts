// Settings → Self-modify. The pure lists are pinned directly; the screen's own
// markup and the switch's config write are pinned through a static render,
// because effects do not run here (the inbox/journal fetch is exercised live).
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import type { Switch } from "./SettingsPrimitives";
import { PendingProposals, SelfModifyJournal, touchesServer, type SelfModifyEntry, type SelfModifyPending } from "./SelfModifySection";
import { SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  section: "selfModify" as AppSettingsSection,
  enabled: true,
  api: vi.fn(() => Promise.resolve({})),
  dispatch: vi.fn(),
  switches: [] as ComponentProps<typeof Switch>[],
}));

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: fixture.api,
  useStore: () => ({
    state: {
      appSettingsSection: fixture.section,
      config: { features: { skillAuthoring: true, selfModify: fixture.enabled } },
    },
    dispatch: fixture.dispatch,
  }),
}));

vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));

vi.mock("./SettingsPrimitives", async (importOriginal) => {
  const original = await importOriginal<typeof import("./SettingsPrimitives")>();
  return {
    ...original,
    Switch: (props: ComponentProps<typeof Switch>) => {
      fixture.switches.push(props);
      return createElement(original.Switch, props);
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "selfModify";
  fixture.enabled = true;
  fixture.switches = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const entry = (overrides: Partial<SelfModifyEntry> = {}): SelfModifyEntry => ({
  id: "edit-1",
  proposedBy: "Astra",
  reason: "fix the empty state copy",
  status: "applied",
  appliedAt: "2026-09-20T00:00:00.000Z",
  verifiedAt: null,
  revertedAt: null,
  revertReason: null,
  files: ["edit src/lib/ui.ts"],
  checks: [{ name: "parse src/lib/ui.ts", ok: true, detail: "parses" }],
  ...overrides,
});

const proposal = (overrides: Partial<SelfModifyPending> = {}): SelfModifyPending => ({
  file: "edit-1.json",
  id: "edit-1",
  proposedBy: "Astra",
  reason: "add a status pill",
  bytes: 2048,
  ...overrides,
});

describe("self-modify helpers", () => {
  it("calls an edit server-touching only when it edits the harness", () => {
    expect(touchesServer(["edit server/bots.ts"])).toBe(true);
    expect(touchesServer(["edit shared/contracts.ts"])).toBe(true);
    expect(touchesServer(["edit src/lib/ui.ts"])).toBe(false);
    expect(touchesServer([])).toBe(false);
  });
});

describe("pending proposals list", () => {
  it("names the author, the id and the size, and asks twice before applying", () => {
    const html = renderToStaticMarkup(
      createElement(PendingProposals, {
        pending: [proposal()],
        busyId: null,
        confirmId: "edit-1",
        onAskApply: vi.fn(),
        onCancelApply: vi.fn(),
        onApply: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );
    expect(html).toContain("add a status pill");
    expect(html).toContain("proposed by Astra");
    expect(html).toContain("edit-1");
    expect(html).toContain("2 KB");
    // the second press is the one that applies
    expect(html).toContain("Confirm");
    expect(html).toContain('aria-label="Discard"');
    expect(html).not.toContain(">Apply<");
  });

  it("shows why an invalid proposal cannot be applied and offers no buttons", () => {
    const html = renderToStaticMarkup(
      createElement(PendingProposals, {
        pending: [proposal({ invalid: "src/x.ts: protected path" })],
        busyId: null,
        confirmId: null,
        onAskApply: vi.fn(),
        onCancelApply: vi.fn(),
        onApply: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );
    expect(html).toContain("protected path");
    expect(html).not.toContain(">Apply<");
    expect(html).not.toContain("Discard");
  });
});

describe("journal list", () => {
  it("marks an applied server change as awaiting its trial boot, with no by-hand verify", () => {
    const html = renderToStaticMarkup(
      createElement(SelfModifyJournal, {
        entries: [entry({ files: ["edit server/bots.ts"] })],
        busyId: null,
        onRevert: vi.fn(),
        onVerify: vi.fn(),
      }),
    );
    expect(html).toContain("unproven");
    expect(html).toContain("the next restart tries it");
    expect(html).toContain(">Revert<");
    expect(html).not.toContain("Mark verified");
  });

  it("offers by-hand verification only for a renderer-only change", () => {
    const html = renderToStaticMarkup(
      createElement(SelfModifyJournal, {
        entries: [entry()],
        busyId: null,
        onRevert: vi.fn(),
        onVerify: vi.fn(),
      }),
    );
    expect(html).toContain("mark it verified once you have seen it work");
    expect(html).toContain("Mark verified");
  });

  it("quotes the revert reason and the failing check", () => {
    const reverted = renderToStaticMarkup(
      createElement(SelfModifyJournal, {
        entries: [entry({ status: "reverted", revertReason: "preflight failed" })],
        busyId: null,
        onRevert: vi.fn(),
        onVerify: vi.fn(),
      }),
    );
    expect(reverted).toContain("Reverted — preflight failed");
    expect(reverted).not.toContain(">Revert<");

    const failed = renderToStaticMarkup(
      createElement(SelfModifyJournal, {
        entries: [entry({ status: "failed", checks: [{ name: "parse server/bots.ts", ok: false, detail: "Unexpected token" }] })],
        busyId: null,
        onRevert: vi.fn(),
        onVerify: vi.fn(),
      }),
    );
    expect(failed).toContain("parse server/bots.ts: Unexpected token");
  });
});

describe("Settings → Self-modify screen", () => {
  const render = () => renderToStaticMarkup(createElement(SettingsModal));

  it("sits in the picker and shows the switch, the failsafes, and the review surfaces", () => {
    const html = render();
    expect(html).toContain('<option value="selfModify" selected="">Self-modify</option>');
    expect(html).toContain("Allow agents to edit this app");
    expect(html).toContain("Failsafes, in order");
    expect(html).toContain("cannot edit its own leash");
    expect(html).toContain("Waiting for review");
    expect(html).toContain("Journal");
  });

  it("hides the inbox and journal while the feature is off", () => {
    fixture.enabled = false;
    const html = render();
    expect(html).toContain("Failsafes, in order");
    expect(html).not.toContain("Waiting for review");
    expect(html).not.toContain("Journal");
  });

  it("writes only the feature flag when the switch is flipped", () => {
    render();
    const toggle = fixture.switches.find((props) => props["aria-label"] === "Allow agents to edit this app's code")!;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(true);
    toggle.onClick!({} as never);
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { selfModify: false } }),
    });
  });
});


