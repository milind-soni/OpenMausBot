// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, reducer, type Bot } from "@/state/store";
import { forgetSidebarShowAllForTests } from "@/lib/sidebar-preferences";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/interface-mode", async (original) => ({ ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => true }));

const { BotThreadList, botRowProps } = await import("./Sidebar");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const makeBot = (tasks: NonNullable<Bot["tasks"]>): Bot => ({
  id: "maus", threadId: "open-main", name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: true, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  projects: [{ id: "taxes", name: "Taxes" }],
  tasks,
});

let host: HTMLElement;
let root: Root;
const mount = async (candidate: Bot) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(BotThreadList, { ...botRowProps(initialState, vi.fn(), candidate, { density: "comfortable", query: "", onMenu: vi.fn() }), selected: true }));
  });
};
const unmount = async () => {
  await act(async () => { root.unmount(); });
  host.remove();
};

beforeEach(() => {
  localStorage.clear();
  forgetSidebarShowAllForTests();
});
afterEach(() => { document.body.innerHTML = ""; });

describe("collapsed folder unread badge with archived threads", () => {
  it("hides the unread dot when the folder's only unread thread is archived, and shows it for an open unread thread", async () => {
    await mount(makeBot([
      { threadId: "open-main", title: "Main chat", createdAt: 10, unread: false },
      { threadId: "filed-archived", title: "Old receipt", createdAt: 5, projectId: "taxes", unread: true, archivedAt: 20 },
    ]));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Collapse Taxes threads"]')!.click();
    });
    const folderLabel = host.querySelector('[data-sidebar-folder-label="taxes"]')!;
    expect(folderLabel.querySelector('[aria-label="Unread threads"]')).toBeNull();
    await unmount();

    await mount(makeBot([
      { threadId: "open-main", title: "Main chat", createdAt: 10, unread: false },
      { threadId: "filed-open", title: "New receipt", createdAt: 5, projectId: "taxes", unread: true },
    ]));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Collapse Taxes threads"]')!.click();
    });
    expect(host.querySelector('[data-sidebar-folder-label="taxes"] [aria-label="Unread threads"]')).not.toBeNull();
    await unmount();
  });

  it("does not leave bot.unread true after select or taskSwitched when only archived or routine threads remain unread", () => {
    const candidate = makeBot([
      { threadId: "open-main", title: "Main chat", createdAt: 10, unread: true },
      { threadId: "filed-archived", title: "Old receipt", createdAt: 5, projectId: "taxes", unread: true, archivedAt: 20 },
      { threadId: "routine-run", title: "Morning run", createdAt: 6, unread: true, routineRunId: "run-1" },
    ]);
    const selected = reducer({ ...initialState, bots: [candidate], selectedId: "other" }, { type: "select", id: "maus" });
    expect(selected.bots[0]!.unread).toBe(false);

    const switched = reducer(
      { ...initialState, bots: [{ ...candidate, threadId: "other-thread" }], selectedId: "maus", activeView: "chat" },
      { type: "taskSwitched", bot: candidate },
    );
    expect(switched.bots[0]!.unread).toBe(false);
  });
});
