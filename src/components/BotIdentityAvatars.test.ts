import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, Message } from "@/state/store";
const fixtureAt = Date.UTC(2026, 8, 7, 12);
const avatarBots: Bot[] = ["Atlas", "Juniper"].map((name, i) => ({
  id: name.toLowerCase(), threadId: "thread-" + name.toLowerCase(), name,
  title: "Test bot", description: "",
  notifications: false, color: i ? "purple" : "green", unread: false,
  avatarUrl: "/api/attachments/fixture-" + i + ".png", avatarCrop: i ? "rounded" : "circle",
  modelSelection: { instanceId: "fixture", model: "fixture-model" },
  tasks: [{ threadId: "thread-" + name.toLowerCase(), title: "Task", createdAt: fixtureAt,
    usage: { input: 100, output: 20, costUsd: 0.01, turns: 1 } }],
  messages: [],
}));
const receipt: Message = { id: "receipt", role: "bot", kind: "activity", at: fixtureAt,
  tool: { name: "Message from @Juniper", ok: true },
  comm: { withBotId: "juniper", withName: "Juniper", withColor: "purple", groupId: "fixture-dm" } };
const avatarGroup: Group = {
  id: "fixture-room", threadId: "thread-room", name: "Group",
  memberIds: ["atlas", "juniper"], defaultResponder: { kind: "member", botId: "atlas" },
  bulletin: "", unread: false, createdAt: fixtureAt, setupCompletedAt: fixtureAt,
  messages: [
    { id: "atlas-message", role: "bot", kind: "text", text: "Hello",
      from: { botId: "atlas", name: "Atlas", color: "green" }, at: fixtureAt },
    { ...receipt, from: { botId: "atlas", name: "Atlas", color: "green" } },
    { id: "deleted-message", role: "bot", kind: "text", text: "Historical message",
      from: { botId: "deleted", name: "Former teammate", color: "orange" }, at: fixtureAt },
  ],
};


vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, useStore: () => ({ state: { ...actual.initialState, bots: avatarBots, groups: [avatarGroup] }, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }) }));
vi.mock("react-dom", async (original) => ({ ...await original<object>(), createPortal: (children: unknown) => children }));
import { GroupView, RoomToolChip } from "./GroupView";
import { UsageSection } from "./UsageSection";
import { TeamMapPage } from "./TeamMapPage";
import { BotInstructionsDialog } from "./BotInstructionsDialog";
const render = (component: Parameters<typeof renderToStaticMarkup>[0]) => {
  vi.stubGlobal("window", { ogb: undefined });
  vi.stubGlobal("document", { body: {} });
  return renderToStaticMarkup(component);
};
afterEach(() => vi.unstubAllGlobals());
describe("uploaded bot identity portraits", () => {
  it("renders the receipt sender image while preserving its navigation button", () => {
    const html = render(createElement(RoomToolChip, { message: receipt }));
    expect(html).toContain('<img src="/api/attachments/fixture-1.png"');
    expect(html).toContain('title="Open Juniper"');
    expect(html).toContain("Message from @Juniper");
  });
  it("keeps a deleted receipt sender readable with a mascot fallback", () => {
    const html = render(createElement(RoomToolChip, { message: { ...receipt, comm: { ...receipt.comm!, withBotId: "deleted" } } }));
    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
    expect(html).toContain("Message from @Juniper");
  });
  it("renders uploaded group header and sender portraits", () => {
    const html = render(createElement(GroupView, { group: avatarGroup }));
    expect(html.match(/<img src="\/api\/attachments\/fixture-0.png"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Historical message");
  });
  it("renders uploaded empty-room portraits as well as member headers", () => {
    const html = render(createElement(GroupView, { group: { ...avatarGroup, messages: [] } }));
    expect(html.match(/<img src="\/api\/attachments\/fixture-0.png"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
  it.each([["usage", UsageSection], ["team map", TeamMapPage]] as const)("renders the uploaded portrait in %s", (_name, Component) => {
    expect(render(createElement(Component))).toContain('<img src="/api/attachments/fixture-0.png"');
  });
  it("renders the instructions portrait without losing dialog semantics", () => {
    const html = render(createElement(BotInstructionsDialog, { bot: avatarBots[0]!, onClose: vi.fn() }));
    expect(html).toContain('<img src="/api/attachments/fixture-0.png"');
    expect(html).toContain('role="dialog"');
  });
});
