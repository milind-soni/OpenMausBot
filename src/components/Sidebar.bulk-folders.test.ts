import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { initialState, type Bot } from "@/state/store";
import type { SelectableRow } from "@/lib/bulk-select";

const fixture = vi.hoisted(() => ({ selecting: false, filterRows: [] as readonly SelectableRow[] }));
// The folder list starts from an empty Set; seeding it is how a folder renders collapsed on first paint.
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => actual.useState(initial instanceof Set && initial.size === 0 ? new Set(["folder"]) : initial) };
});
vi.mock("./BulkSelectBar", async (original) => {
  const actual = await original<typeof import("./BulkSelectBar")>();
  return {
    ...actual,
    useBulkSelect: () => ({ active: fixture.selecting, start: vi.fn(), finish: vi.fn(), setSelected: vi.fn(), toggle: vi.fn(), forRows: () => new Set<string>() }),
    BulkSelectFilters: (props: { rows: readonly SelectableRow[] }) => { fixture.filterRows = props.rows; return null; },
  };
});
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/interface-mode", async (original) => ({ ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => true }));

const { BotThreadList, botRowProps } = await import("./Sidebar");

const bot: Bot = {
  id: "maus", threadId: "loose", name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  projects: [{ id: "folder", name: "Taxes" }],
  tasks: [
    { threadId: "loose", title: "Loose chat", createdAt: 2 },
    { threadId: "filed", title: "Filed chat", createdAt: 1, projectId: "folder" },
  ],
};
const render = () => renderToStaticMarkup(createElement(BotThreadList, {
  ...botRowProps(initialState, vi.fn(), bot, { density: "comfortable", quiet: false, query: "", onMenu: vi.fn() }), selected: true,
}));

describe("selecting threads in a bot with a collapsed folder", () => {
  it("opens the folder so Select all reaches the threads inside it", () => {
    fixture.selecting = false;
    expect(render()).not.toContain("Filed chat");

    fixture.selecting = true;
    expect(render()).toContain("Filed chat");
    expect(fixture.filterRows.map((row) => row.threadId)).toEqual(["filed", "loose"]);
  });
});
