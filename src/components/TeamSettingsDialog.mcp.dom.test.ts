// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, type Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ bots: [] as unknown[], saved: [] as Array<{ id: string; patch: unknown }> }));

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { ...initialState, bots: fixture.bots }, dispatch: vi.fn() }),
  persistBotUpdate: async (id: string, patch: unknown) => {
    fixture.saved.push({ id, patch });
    return { ...(fixture.bots as Bot[]).find((bot) => bot.id === id), ...(patch as object) };
  },
}));
vi.mock("@/lib/mcp-servers", () => ({
  useMcpServers: () => ({ servers: [
    { name: "notion", enabled: true }, { name: "drive", enabled: true }, { name: "fake", enabled: false }, { name: "sketch", enabled: true, bot: "analyst" },
  ], error: false, refresh: async () => [] }),
}));
vi.mock("./bot-access/ShareBotButton", () => ({ useTeamName: () => null }));
vi.mock("@/state/team-people", () => ({ useTeamPeople: () => null }));

import { TeamMenuItems } from "./SidebarTeamMenu";
import { TeamSettingsDialog } from "./TeamSettingsDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = (id: string, mcpServers: string[] | null) => ({
  id, threadId: `${id}-t`, name: id, title: "", description: "", notifications: true, color: "blue", unread: false,
  modelSelection: { instanceId: "claude", model: "opus" }, section: "BI", ...(mcpServers ? { mcpServers } : {}),
}) as Bot;

const mount = async (element: ReturnType<typeof createElement>) => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root.render(element); });
  return root;
};
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text);
const click = async (element: HTMLElement | undefined) => {
  expect(element).toBeDefined();
  await act(async () => { element!.click(); });
};

afterEach(() => {
  document.body.innerHTML = "";
  fixture.saved = [];
});

describe("MCP servers for an area", () => {
  it("is on the department menu only when the caller offers it", async () => {
    const base = { onAddBots: vi.fn(), onRename: vi.fn(), onShare: vi.fn(), onDelete: vi.fn() };
    const without = await mount(createElement(TeamMenuItems, base));
    expect(button("MCP servers for this area")).toBeUndefined();
    act(() => without.unmount());
    const open = vi.fn();
    await mount(createElement(TeamMenuItems, { ...base, onMcpServers: open }));
    await click(button("MCP servers for this area"));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("adds the ticked servers to each bot's own selection, one bot at a time, and leaves a bot on every server as it is", async () => {
    fixture.bots = [bot("analyst", ["notion"]), bot("reporter", null), bot("closer", ["drive", "notion"]), { ...bot("other", ["notion"]), section: "Sales" }];
    await mount(createElement(TeamSettingsDialog, { team: "BI", tab: "mcp", onClose: vi.fn() }));
    const choices = [...document.querySelectorAll("[data-team-mcp] label")].map((label) => label.textContent);
    expect(choices, "only servers every bot may use, an off one marked").toEqual(["notion", "drive", "fakeOff"]);
    expect(button("Apply to 0 bots")?.disabled).toBe(true);

    const tick = async (name: string) => {
      const box = [...document.querySelectorAll<HTMLLabelElement>("[data-team-mcp] label")].find((label) => label.textContent?.startsWith(name))!.querySelector("input")!;
      await act(async () => { box.click(); });
    };
    await tick("drive");
    const rows = () => [...document.querySelectorAll("[data-testid='team-settings-rows'] li")].map((row) => row.textContent);
    expect(rows()).toEqual(["analystWill change", "reporterAlready set", "closerAlready set"]);
    await tick("fake");
    expect(rows()).toEqual(["analystWill change", "reporterAlready set", "closerWill change"]);

    await click(button("Apply to 2 bots"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(fixture.saved).toEqual([
      { id: "analyst", patch: { mcpServers: ["notion", "drive", "fake"] } },
      { id: "closer", patch: { mcpServers: ["drive", "notion", "fake"] } },
    ]);
    expect(document.querySelector("[role='status']")?.textContent).toBe("2 applied · 1 already set · 0 skipped");
  });
});
