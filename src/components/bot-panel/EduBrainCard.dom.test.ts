// @vitest-environment happy-dom
// Bot settings, Memory, Edu brain: what Edu can do for this bot, and the proposals that wait for the person.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EduBrainView } from "../../../shared/edu-brain";

const fixture = vi.hoisted(() => ({ api: vi.fn(), view: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));

const { EduBrainCard } = await import("./EduBrainCard");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const bot = { id: "luna", name: "Luna", busy: false };
const ready = (patch: Partial<EduBrainView> = {}): EduBrainView => ({
  state: "ready", mode: "own", version: "6.0.0", brain: "/data/brains/luna", home: "/home/edu/.edu", mayApprove: true,
  proposals: [
    { id: "K-iso", title: "Use ISO dates", kind: "standard", band: "verified", why: "needs human confirmation", brain: "/data/brains/luna", global: false, location: "/data/brains/luna", body: "Dates as YYYY-MM-DD." },
    { id: "K-short", title: "Short answers", kind: "preference", band: "inferred", why: "interpretation", brain: "/data/brains/luna", global: true, location: "/home/edu/.edu" },
  ],
  ...patch,
});
const render = async () => { await act(async () => root.render(createElement(EduBrainCard, { bot }))); };
const text = () => host.textContent ?? "";
const rows = () => [...host.querySelectorAll("[data-panel-row=edu-proposal]")];

beforeEach(() => {
  fixture.view = ready();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => (path.endsWith("/edu") ? fixture.view : { ok: true, outcome: "allowed-once" }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("shows Edu's version, the brain folders and each pending proposal, the global one with its warning", async () => {
  await render();
  expect(text()).toContain("On · Edu 6.0.0");
  expect(text()).toContain("/data/brains/luna");
  expect(text()).toContain("/home/edu/.edu");
  expect(rows()).toHaveLength(2);
  expect(rows()[0]!.textContent).toContain("Dates as YYYY-MM-DD.");
  expect(rows()[0]!.querySelector("[data-edu-global]")).toBeNull();
  expect(rows()[1]!.querySelector("[data-edu-global]")?.textContent).toBe("Approving changes your global Edu brain, which every coding CLI with Edu reads.");
});

it("words each proposal plainly and keeps Edu's own fields behind Details, a global one's path being the global brain", async () => {
  await render();
  expect(rows()[0]!.querySelector("[data-edu-facts]")?.textContent).toBe("Rule · Verified · Luna's Edu brain");
  expect(rows()[1]!.querySelector("[data-edu-facts]")?.textContent).toBe("Preference · Inferred · Global Edu brain");
  expect(rows()[0]!.textContent).not.toMatch(/standard|unbanded|needs human confirmation|\/data\/brains/);
  await act(async () => (rows()[1]!.querySelector("[data-edu-details]") as HTMLButtonElement).click());
  const fields = rows()[1]!.querySelector("pre")!.textContent!;
  expect(fields).toBe("id: K-short\nkind: preference\nband: inferred\nwhy: interpretation\npath: /home/edu/.edu");
});

it("names a shared brain by its folder", async () => {
  fixture.view = ready({ mode: "folder", proposals: [{ id: "K-a", title: "A", kind: "lexicon", band: "unbanded", why: "", brain: "/srv/team-notes", global: false, location: "/srv/team-notes", shared: true }] });
  await render();
  expect(rows()[0]!.querySelector("[data-edu-facts]")?.textContent).toBe("Term · Shared brain (team-notes)");
});

it("approves and rejects through the bot's Edu route, then reads the list again", async () => {
  await render();
  await act(async () => (rows()[0]!.querySelector("[data-edu-action=approve]") as HTMLButtonElement).click());
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/luna/edu/proposals/K-iso", { method: "POST", body: JSON.stringify({ action: "approve" }) });
  await act(async () => (rows()[1]!.querySelector("[data-edu-action=reject]") as HTMLButtonElement).click());
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/luna/edu/proposals/K-short", { method: "POST", body: JSON.stringify({ action: "reject" }) });
  expect(fixture.api.mock.calls.filter(([path]) => path === "/api/bots/luna/edu")).toHaveLength(3);
});

it("leaves only Reject where this caller may not approve, and says where to approve", async () => {
  fixture.view = ready({ mayApprove: false });
  await render();
  expect(text()).toContain("Approve these in the desktop app or from a paired device.");
  expect((rows()[0]!.querySelector("[data-edu-action=approve]") as HTMLButtonElement).disabled).toBe(true);
  expect((rows()[0]!.querySelector("[data-edu-action=reject]") as HTMLButtonElement).disabled).toBe(false);
});

it("says plainly what to do when Edu is missing, old or off, and lists nothing", async () => {
  fixture.view = { state: "missing", mode: "own", home: "/home/edu/.edu", proposals: [], mayApprove: false };
  await render();
  expect(text()).toContain("Not installed");
  expect(text()).toContain("Install Edu from github.com/EduardoMoraga/edu");
  expect(rows()).toHaveLength(0);
  expect(text()).not.toContain("Waiting for your approval");

  fixture.view = { state: "old", mode: "own", version: "5.0.1", home: "/h", proposals: [], mayApprove: false };
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect(text()).toContain("Edu 5.0.1 is too old");
  expect(text()).toContain("Run edu update");

  fixture.view = { state: "off", mode: "off", home: "/h", proposals: [], mayApprove: false };
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect(text()).toContain("Off for this bot");
});

it("says when nothing waits", async () => {
  fixture.view = ready({ proposals: [] });
  await render();
  expect(text()).toContain("Nothing is waiting for your approval.");
});
