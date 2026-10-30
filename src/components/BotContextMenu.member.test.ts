import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ advanced: true, admin: false as boolean | null }));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useLayoutEffect: () => {} }));
vi.mock("react-dom", async (importOriginal) => ({ ...await importOriginal<typeof import("react-dom")>(), createPortal: (node: ReactNode) => node }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: [chief, scout] }, dispatch: vi.fn() }) };
});

const { BotContextMenu } = await import("./Sidebar");
const base = { threadId: "thread", title: "", description: "", notifications: true, color: "green", unread: false, messages: [], modelSelection: { instanceId: "test", model: "test" } } as const;
const scout = { ...base, id: "scout", name: "Scout", tasks: [{ threadId: "thread", title: "a" }, { threadId: "t2", title: "b" }] } as unknown as Bot;
const chief = { ...base, id: "luna", name: "Luna", chiefOfStaff: true } as unknown as Bot;

beforeEach(() => {
  fixture.advanced = true;
  fixture.admin = false;
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("window", { innerWidth: 1_000, innerHeight: 800, addEventListener: () => {}, removeEventListener: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

const render = (bot: Bot) => renderToStaticMarkup(createElement(BotContextMenu, {
  menu: { botId: bot.id, x: 10, y: 10 }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(),
  onMoveToSection: vi.fn(), onNewFolder: vi.fn(), onNewTaskFolder: vi.fn(),
}));

describe("a team bot's actions for a session without the admin scope", () => {
  it("offers nothing it would refuse and says why the crown is greyed", () => {
    const html = render(scout);
    for (const refused of [">Archive</button>", ">Delete</button>", "Duplicate", "Move to department", "Delete all threads"]) expect(html).not.toContain(refused);
    expect(html).toContain('title="Only an admin of this installation can choose the Chief of Staff."');
    expect(html).not.toContain("Choose Claude or an ACP model provider first");
  });

  it("does not offer to remove a Chief of Staff", () => {
    const html = render(chief);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Only an admin of this installation can choose the Chief of Staff\."[^>]*>.*Remove Chief of Staff/);
  });

  it("leaves Archive, Delete and Move to department out of the simple menu", () => {
    fixture.advanced = false;
    const html = render(scout);
    for (const refused of [">Archive</button>", ">Delete</button>", "Move to department"]) expect(html).not.toContain(refused);
  });

  it("keeps every action for an admin", () => {
    fixture.admin = true;
    const html = render(scout);
    for (const offered of [">Archive</button>", ">Delete</button>", "Duplicate", "Move to department"]) expect(html).toContain(offered);
    expect(html).toContain("Choose Claude or an ACP model provider first");
  });
});
