import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

import type { Disclose } from "./SettingsSimplePages";

const fixture = vi.hoisted(() => ({ admin: false as boolean | null }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("./EnginesSettings", () => ({ EnginesSettings: () => "AI ACCOUNTS" }));
vi.mock("./LocalComputerSection", () => ({ LocalComputerSection: () => "CLOUD DESKTOPS" }));
vi.mock("./UsageSection", () => ({ UsageSection: () => "USAGE TABLE" }));
vi.mock("./PlanUsage", () => ({ PlanUsageSummary: () => "PLAN USAGE" }));
vi.mock("./CloudUsageMeter", () => ({ useCloudUsageSettings: () => ({ usage: null, upgrade: null, dialog: null }), CloudUsageDetails: () => null, CloudUsageSummaryView: () => null }));
vi.mock("./ProIntroduction", () => ({ useCloudPlan: () => null, CloudPlanRow: () => null, CloudPlanFootnote: () => null }));
vi.mock("./BrowserSettingsRows", () => ({ BuiltInBrowserRow: () => null }));
vi.mock("./AppSettingsRows", async (original) => ({ ...await original<object>(), BrowserProfilesRow: () => null }));
vi.mock("./LoginsSettings", () => ({ LoginsSettings: () => null }));

const { SimpleAiPage, SimpleBillingPage, SimpleComputerPage } = await import("./SettingsSimplePages");

const has = () => true;
const disclose: Disclose = (id) => ({ id, open: true, onToggle: () => {} });
const remoteAccess = { client: null, domain: null, pairing: null, companion: null };
const pages = () => [
  renderToStaticMarkup(createElement(SimpleAiPage, { has, disclose, connections: "KEYS" })),
  renderToStaticMarkup(createElement(SimpleComputerPage, { has, disclose, remoteAccess, servers: null })),
  renderToStaticMarkup(createElement(SimpleBillingPage, { has, disclose, cloudAccount: null })),
].join("\n");

beforeEach(() => { fixture.admin = false; });

it("shows a session without the admin scope a plain sentence instead of the installation's AI, computers and usage", () => {
  const html = pages();
  for (const hidden of ["AI ACCOUNTS", "KEYS", "CLOUD DESKTOPS", "USAGE TABLE", "PLAN USAGE"]) expect(html).not.toContain(hidden);
  expect(html).toContain("Only an admin of this installation can change this.");
  expect(html).toContain("Only an admin of this installation can see usage.");
});

it("keeps them for an admin", () => {
  fixture.admin = true;
  const html = pages();
  for (const shown of ["AI ACCOUNTS", "KEYS", "CLOUD DESKTOPS", "USAGE TABLE", "PLAN USAGE"]) expect(html).toContain(shown);
});
