// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), track: vi.fn(), bots: [] as Array<{ name: string; installedPackage: { id: string; name: string } }> }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {}, bots: f.bots }, dispatch: f.dispatch }), api: f.api }));
vi.mock("@/lib/analytics", () => ({ track: f.track }));

import { setLocale } from "@/lib/i18n";
import { previewHermesMove } from "@/lib/hermes-move";
import { HERMES_EXPORT_FORMAT, HERMES_EXPORT_PROMPT, parseHermesExport } from "../../shared/hermes-import";
import { HermesMoveDialog } from "./HermesMoveDialog";
import { HermesImportSection } from "./HermesImportSection";
import { SettingsLook } from "./SettingsPrimitives";

const EXPORT = JSON.stringify({ format: HERMES_EXPORT_FORMAT, version: 1, bots: [{
  name: "Orchid", instructions: "Keep replies short.", memories: ["Launch on December 15"],
  skills: [{ name: "Daily brief", instructions: "Summarize the work in three bullets." }],
  routines: [{ name: "Morning", instruction: "Write the brief.", schedule_cron: "0 9 * * 1-5", timezone: "Asia/Kolkata" }],
}] });
let root: Root;
let host: HTMLElement;
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)!;
const paste = async (text: string) => {
  await act(async () => {
    const box = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Continue").click());
};
beforeEach(() => {
  setLocale("en");
  f.bots = [];
  f.api.mockReset();
  f.dispatch.mockReset();
  f.track.mockReset();
  vi.stubGlobal("ogb", { remoteClient: { active: false } });
  f.api.mockImplementation(async (path: string) => path.startsWith("/api/teams/import")
    ? { bots: [{ id: "b1", name: "Orchid", threadId: "t1" }] }
    : path === "/api/mcp/servers" ? { servers: [] } : {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("copies the Hermes message, previews and imports through its own dialog without reading local Grok files", async () => {
  await act(async () => root.render(createElement(HermesMoveDialog, { onClose: vi.fn() })));
  expect(host.textContent).toContain("Move from Hermes");
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  try {
    await act(async () => button("Copy the message").click());
    expect(write).toHaveBeenCalledWith(HERMES_EXPORT_PROMPT);
  } finally {
    write.mockRestore();
  }
  await paste(EXPORT);
  expect(host.querySelector('[data-hermes-move="preview"]')).not.toBeNull();
  expect(host.textContent).toContain("Routines come over paused.");
  expect(f.api.mock.calls.some(([path]) => path.startsWith("/api/teams/import"))).toBe(false);
  await act(async () => button("Import").click());
  expect(host.querySelector('[data-hermes-move="report"]')).not.toBeNull();
  expect(host.textContent).toContain("Turn each one off in Hermes");
  expect(host.textContent).toContain("Supporting skill files");
  expect(host.textContent).not.toContain("Grok Bot");
  expect(f.api.mock.calls.map(([path]) => path)).not.toContain("/api/setup-import/grok");
  const imported = f.api.mock.calls.find(([path]) => path === "/api/teams/import?mode=add")!;
  expect(JSON.parse(imported[1].body).package.author.name).toBe("Hermes");
  expect(f.track).toHaveBeenCalledWith("team_imported", expect.objectContaining({ source: "hermes" }));
});

it("keeps an already-imported Hermes profile from being added again", async () => {
  const plan = previewHermesMove(parseHermesExport(EXPORT), { bots: [], servers: new Set(), timeZone: "UTC" }).plans[0]!;
  f.bots = [{ name: "Orchid", installedPackage: { id: plan.packageId, name: "Orchid" } }];
  await act(async () => root.render(createElement(HermesMoveDialog, { onClose: vi.fn() })));
  await paste(EXPORT);
  expect(host.textContent).toContain("Already here: Orchid");
  expect(button("Import").disabled).toBe(true);
});

it("refuses credentials through the Hermes entry point", async () => {
  await act(async () => root.render(createElement(HermesMoveDialog, { onClose: vi.fn() })));
  await paste(JSON.stringify({ format: HERMES_EXPORT_FORMAT, bots: [{ name: "Leaky", api_key: "private" }] }));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("passwords or keys");
  expect(f.api.mock.calls.some(([path]) => path.startsWith("/api/teams/import"))).toBe(false);
});

it("opens the dedicated Hermes section inline at its settings search anchor", async () => {
  await act(async () => root.render(createElement(SettingsLook.Provider, { value: true }, createElement(HermesImportSection))));
  expect(host.querySelector('[data-settings-block="hermes-move"]')).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>("[data-hermes-move-open]")!.click());
  await vi.waitFor(() => expect(host.querySelector('[data-hermes-move="start"]')).not.toBeNull());
  expect(host.querySelector(".ui-scrim")).toBeNull();
});
