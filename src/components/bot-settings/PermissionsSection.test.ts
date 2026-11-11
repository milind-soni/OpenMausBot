// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));

const { BotEditorStore, initialState } = await import("@/state/store");
const { PermissionsSection } = await import("./PermissionsSection");
const { setTeamPeople } = await import("@/state/team-people");
const { t } = await import("@/lib/i18n");
type Derived = Parameters<typeof PermissionsSection>[0]["derived"];

const base: Bot = {
  id: "pepper", name: "Pepper", threadId: "current", title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "claude", model: "fixture" }, approvalMode: "ask",
  tasks: [{ threadId: "current", title: "Current thread", createdAt: 1, approvalMode: "ask" }],
};
const dispatch = vi.fn();
let host: HTMLDivElement;
let root: Root;

function render(bot: Bot, trustedModesAvailable = false, others: Bot[] = []) {
  const derived = {
    patch: (patch: object) => dispatch({ type: "updateBot", botId: bot.id, patch }),
    engine: { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude" },
    canCoordinate: true, approvalMode: bot.approvalMode ?? "ask", trustedModesAvailable,
    sectionName: "General", currentChief: undefined,
  } as unknown as Derived;
  flushSync(() => root.render(createElement(BotEditorStore, {
    value: { state: { ...initialState, bots: [bot, ...others] }, dispatch,
      flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
    children: createElement(PermissionsSection, { bot, derived }),
  })));
}
const choose = (label: string) => {
  flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
  const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    .find((button) => button.textContent?.startsWith(label));
  if (!item) throw new Error(`No ${label} level offered`);
  flushSync(() => item.click());
};
const dialogs = () => document.querySelectorAll('[role="alertdialog"], [role="dialog"]').length;

beforeEach(() => {
  dispatch.mockReset();
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Full access in bot settings", () => {
  it.each([false, true])("applies to the bot and every thread at once, with no dialog (desktop bridge: %s)", (bridge) => {
    render(base, bridge);
    choose("Full access");
    expect(dialogs()).toBe(0);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "updateBot", botId: "pepper", patch: { approvalMode: "full", applyToAllThreads: true },
    });
  });

  it("re-applies Full to every thread from its button, with no dialog and no desktop bridge", () => {
    render({ ...base, approvalMode: "full" });
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === "Apply Full access to all threads");
    expect(button).toBeDefined();
    flushSync(() => button!.click());
    expect(dialogs()).toBe(0);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "updateBot", botId: "pepper", patch: { approvalMode: "full", applyToAllThreads: true },
    });
  });

  it("still warns before Auto on this computer", () => {
    render({ ...base, computer: "local" });
    choose("Approve for me");
    expect(dispatch).not.toHaveBeenCalled();
    expect(dialogs()).toBe(1);
  });
});

describe("on a team", () => {
  const chief: Bot = { ...base, chiefOfStaff: true, managedSections: ["Sales"] };
  afterEach(() => setTeamPeople(null));

  it("offers no Chief of Staff card and no departments to be in charge of; off a team both stay", () => {
    render(chief);
    expect(host.textContent).toContain(t("permissions.chief.title"));
    expect(host.textContent).toContain(t("botAccess.teams.title"));
    setTeamPeople({ people: [], me: null, admin: true, needsYou: [] });
    render(chief);
    expect(host.textContent).not.toContain(t("permissions.chief.title"));
    expect(host.textContent).not.toContain(t("botAccess.teams.title"));
  });
});

describe("PermissionsSection parts", () => {
  it("leaves Chief of Staff out of a page that asks only for approvals", () => {
    const derived = {
      patch: vi.fn(), engine: { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude" },
      canCoordinate: true, approvalMode: "ask", trustedModesAvailable: false, sectionName: "General", currentChief: undefined,
    } as unknown as Derived;
    flushSync(() => root.render(createElement(BotEditorStore, {
      value: { state: { ...initialState, bots: [base] }, dispatch,
        flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
      children: createElement(PermissionsSection, { bot: base, derived, parts: ["approval", "outbound"] }),
    })));
    expect(host.textContent).toContain("Approval level");
    expect(host.textContent).toContain("Sending on your behalf");
    expect(host.textContent).not.toContain("Chief of Staff");
    render(base);
    expect(host.textContent).toContain("Chief of Staff");
  });
});

describe("Sending on your behalf", () => {
  const option = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

  it("asks every time by default, and one click sends without asking", () => {
    render(base);
    expect(option("Ask every time")?.getAttribute("aria-pressed")).toBe("true");
    flushSync(() => option("Send without asking")!.click());
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "updateBot", botId: "pepper", patch: { outbound: { policy: "allow" } } });
  });

  it("has no limit to set or count, even for a rule saved with a daily cap", () => {
    const fetched = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetched);
    render({ ...base, outbound: { policy: "allow", dailyCap: 25 } as Bot["outbound"] });
    expect(option("Send without asking")?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).not.toContain("used today");
    expect(host.textContent).not.toContain("25");
    expect(fetched).not.toHaveBeenCalled();
    flushSync(() => option("Ask every time")!.click());
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "updateBot", botId: "pepper", patch: { outbound: { policy: "ask" } } });
  });
});
