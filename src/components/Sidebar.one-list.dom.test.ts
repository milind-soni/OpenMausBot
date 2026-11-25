// @vitest-environment happy-dom
// The one list in the real Sidebar: with "This computer and My Cloud together" on, the other place's bots are rows among
// this place's own; with it off, or with main never answering, the sidebar is exactly as it was.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { PlaceBotRow, PlacesTogetherState } from "@/lib/places-together";

const mode = vi.hoisted(() => ({ advanced: false }));
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => mode.advanced,
}));
vi.mock("@/lib/thread-preferences", async (original) => ({
  ...await original<typeof import("@/lib/thread-preferences")>(), useShowThreads: () => mode.advanced,
}));
vi.mock("./DesktopCapabilities", async (original) => ({
  ...await original<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: false, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));

const { Sidebar } = await import("./Sidebar");
const { BotEditorStore, initialState } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");
const { resetPlacesTogetherForTest } = await import("@/lib/places-together");
const { resetPlaceRowsForTest } = await import("@/lib/place-rows");

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), threadId: `${id}-t`, title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "test", model: "test" },
  tasks: [{ threadId: `${id}-t`, title: "Chat", createdAt: 1 }], ...extra,
});
const row = (id: string, over: Partial<PlaceBotRow> = {}): PlaceBotRow => ({ home: "cloud", id, threadId: `t-${id}`, name: id[0]!.toUpperCase() + id.slice(1), color: "blue", ...over });
const said = (over: Partial<PlacesTogetherState> = {}): PlacesTogetherState => ({ v: 1, available: true, on: true, here: "computer",
  other: { home: "cloud", state: "ready", bots: [row("scout", { title: "Open issues" }), row("tech", { unread: true, title: "Deploy check", lastAt: 9_000, preview: "Deploy **passed** on staging." })] }, ...over });
const OWN = [bot("mausbot", { chiefOfStaff: true }), bot("git"), bot("ledger")];

const dispatch = vi.fn();
let host: HTMLDivElement, root: Root, answer: () => Promise<PlacesTogetherState>, changed: () => void;
const page = {
  state: vi.fn(() => answer()),
  set: vi.fn(async () => said()),
  open: vi.fn(async () => true),
  onChanged: vi.fn((callback: () => void) => { changed = callback; return () => {}; }),
};
const tree = (bots: Bot[], icons = false) => createElement(BotEditorStore, {
  value: { state: { ...initialState, connected: true, bots, selectedId: bots[0]!.id }, dispatch,
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
  children: createElement(Sidebar, { open: true, onClose: () => {}, collapseToIcons: icons }),
});
async function render(bots = OWN, icons = false) {
  await act(async () => root.render(tree(bots, icons)));
  await act(async () => { await Promise.resolve(); });
}
const q = (selector: string) => host.querySelector<HTMLElement>(selector);
const ids = (selector = "") => [...host.querySelectorAll<HTMLElement>(`${selector} [data-sidebar-bot-row]`)].map((item) => item.dataset.sidebarBotRow);
const mark = (id: string) => q(`[data-sidebar-bot-row="${id}"] [data-bot-place]`);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  dispatch.mockReset();
  for (const fn of Object.values(page)) fn.mockClear();
  answer = async () => said();
  localStorage.clear();
  setLocale("en");
  mode.advanced = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetPlacesTogetherForTest();
  resetPlaceRowsForTest();
  vi.unstubAllGlobals();
  delete (window as { ogb?: unknown }).ogb;
});

async function htmlWith(ogb: unknown, bots = OWN): Promise<string> {
  if (ogb) window.ogb = ogb as never; else delete (window as { ogb?: unknown }).ogb;
  await render(bots);
  // React's generated ids count up across roots; everything else is compared as drawn.
  const html = host.innerHTML.replace(/r[0-9a-z]{1,3}(?=[-"#)])/g, "r#");
  await act(async () => root.unmount());
  resetPlacesTogetherForTest();
  resetPlaceRowsForTest();
  root = createRoot(host);
  return html;
}

describe("switch off: nothing changes", () => {
  for (const advanced of [false, true]) {
    it(`the ${advanced ? "Advanced" : "Simple"} sidebar is the same with the switch off, with main never answering, and in a browser`, async () => {
      mode.advanced = advanced;
      const bots = [...OWN, bot("nova", { unread: true, tasks: [{ threadId: "nova-t", title: "Chat", createdAt: 1, unread: true }] })];
      const browser = await htmlWith(null, bots);
      answer = async () => said({ on: false, other: null });
      const off = await htmlWith({ placesTogether: page }, bots);
      answer = () => new Promise(() => {});
      const silent = await htmlWith({ placesTogether: page }, bots);
      expect(off).toBe(browser);
      expect(silent).toBe(browser);
      expect(browser).not.toContain("data-bot-place");
      expect(page.state).toHaveBeenCalled();
    });
  }
});

describe("switch on: one list", () => {
  it("lists My Cloud's bots in the same list as this computer's, with no group or heading of their own", async () => {
    window.ogb = { placesTogether: page } as never;
    await render();
    expect(ids('[data-sidebar-section-id="builtin:bots"]')).toEqual(["git", "ledger", "cloud:scout", "cloud:tech"]);
    expect(q('[data-sidebar-section-id="builtin:unread"]')).toBeNull();
    expect([...host.querySelectorAll("[data-section]")].map((header) => header.getAttribute("data-section"))).not.toContain("On My Cloud");
    expect(q("[data-other-place]")).toBeNull();
    expect(q('[data-sidebar-bot-row="cloud:scout"]')!.textContent).toContain("Open issues");
    expect(q('[data-sidebar-bot-row="cloud:tech"]')!.textContent).toContain("Deploy passed on staging.");
  });

  it("unread rows of both places keep their places in the one list", async () => {
    window.ogb = { placesTogether: page } as never;
    const nova = bot("nova", { unread: true, tasks: [{ threadId: "nova-t", title: "Chat", createdAt: 1, updatedAt: 5_000, unread: true }] });
    answer = async () => said({ other: { home: "cloud", state: "ready", bots: [row("old", { unread: true, lastAt: 1_000 }), row("tech", { unread: true, lastAt: 9_000 })] } });
    await render([...OWN, nova]);
    expect(ids('[data-sidebar-section-id="builtin:bots"]')).toEqual(["git", "ledger", "nova", "cloud:old", "cloud:tech"]);
    expect(q('[data-sidebar-section-id="builtin:unread"]')).toBeNull();
  });

  it("a bot with the same id in both places is two rows, each its own", async () => {
    window.ogb = { placesTogether: page } as never;
    answer = async () => said({ other: { home: "cloud", state: "ready", bots: [row("git", { name: "Git there" })] } });
    await render();
    expect(ids('[data-sidebar-section-id="builtin:bots"]')).toEqual(["git", "ledger", "cloud:git"]);
    expect(q('[data-sidebar-bot-row="cloud:git"]')!.textContent).toContain("Git there");
  });

  it("every row names its place to a screen reader; on screen the mark waits for hover or keyboard focus", async () => {
    window.ogb = { placesTogether: page } as never;
    await render();
    for (const [id, label, home] of [["git", "Lives on this computer", "computer"], ["cloud:scout", "Lives on My Cloud", "cloud"]] as const) {
      const icon = mark(id)!;
      expect(icon.getAttribute("aria-label")).toBe(label);
      expect(icon.getAttribute("role")).toBe("img");
      expect(icon.getAttribute("data-bot-home")).toBe(home);
      expect(icon.getAttribute("data-bot-place-shows")).toBe("hover");
      const classes = icon.getAttribute("class")!.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["opacity-0", "group-hover:opacity-100", "group-focus-within:opacity-100"]));
      // The focusable row is inside the same group, so keyboard focus on it shows the mark as hover does.
      const group = icon.closest(".group")!;
      expect(group.querySelector(`[data-sidebar-bot-row="${id}"]`)!.getAttribute("tabindex")).toBe("0");
      expect(group.contains(icon)).toBe(true);
    }
  });

  it("the mark stays at rest only while it says something: working, asleep, can't be reached", async () => {
    window.ogb = { placesTogether: page } as never;
    answer = async () => said({ other: { home: "cloud", state: "ready", bots: [row("scout", { working: true }), row("atlas")] } });
    await render([...OWN.slice(0, 2), bot("ledger", { busy: true })]);
    expect(mark("cloud:scout")!.getAttribute("data-bot-place-shows")).toBe("always");
    expect(mark("cloud:scout")!.getAttribute("aria-label")).toBe("Working on My Cloud now");
    expect(mark("ledger")!.getAttribute("aria-label")).toBe("Working on this computer now");
    expect(mark("cloud:atlas")!.getAttribute("data-bot-place-shows")).toBe("hover");
    answer = async () => said({ other: { home: "cloud", state: "asleep", bots: [row("atlas")] } });
    await act(async () => changed());
    await act(async () => { await Promise.resolve(); });
    expect(mark("cloud:atlas")!.getAttribute("data-bot-place")).toBe("cloud-asleep");
    expect(mark("cloud:atlas")!.getAttribute("data-bot-place-shows")).toBe("always");
    expect(mark("cloud:atlas")!.getAttribute("class")).toContain("text-ink-tertiary");
    expect(mark("cloud:atlas")!.getAttribute("aria-label")).toBe("My Cloud is asleep. Opening Atlas wakes it.");
    // Asleep is normal: the row is drawn as any other, not dimmed, not an alert.
    expect(q('[data-sidebar-bot-row="cloud:atlas"]')!.closest(".group")!.className).not.toContain("opacity-");
    expect(host.querySelector("[role=alert], [role=dialog]")).toBeNull();
    answer = async () => said({ other: { home: "cloud", state: "offline", bots: [row("atlas")] } });
    await act(async () => changed());
    await act(async () => { await Promise.resolve(); });
    expect(mark("cloud:atlas")!.getAttribute("data-bot-place")).toBe("cloud-off");
    expect(mark("git")!.getAttribute("data-bot-place-shows")).toBe("hover");
  });

  it("clicking a row of the other place opens its bot there, by its own id; this place's store never hears of it", async () => {
    window.ogb = { placesTogether: page } as never;
    await render();
    await act(async () => q('[data-sidebar-bot-row="cloud:scout"]')!.click());
    expect(page.open.mock.calls).toEqual([["scout"]]);
    await act(async () => { q('[data-sidebar-bot-row="cloud:tech"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(page.open.mock.calls).toEqual([["scout"], ["tech"]]);
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("cloud:");
  });

  it("a row of the other place has no menu and no rename here: those belong to its own page", async () => {
    window.ogb = { placesTogether: page } as never;
    await render();
    expect(q('[data-bot-actions="git"]')).not.toBeNull();
    expect(q('[data-bot-actions="cloud:scout"]')).toBeNull();
    const name = [...q('[data-sidebar-bot-row="cloud:scout"]')!.querySelectorAll("span")].find((span) => span.textContent === "Scout")!;
    await act(async () => { name.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(q('[data-sidebar-bot-row="cloud:scout"] input')).toBeNull();
    await act(async () => { q('[data-sidebar-bot-row="cloud:scout"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    expect(host.querySelector("[role=menu]")).toBeNull();
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("cloud:");
  });

  it("the sidebar's search finds rows of both places", async () => {
    window.ogb = { placesTogether: page } as never;
    mode.advanced = true;
    await render();
    const search = q('input[aria-label]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(search, "sco");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ids()).toEqual(["cloud:scout"]);
  });

  it("in the avatars-only sidebar the place joins each row's own label", async () => {
    window.ogb = { placesTogether: page } as never;
    mode.advanced = true;
    await render(OWN, true);
    expect(q('[data-sidebar-bot-row="cloud:scout"]')!.getAttribute("aria-label")).toContain("Lives on My Cloud");
    expect(q('[data-sidebar-bot-row="git"]')!.getAttribute("aria-label")).toContain("Lives on this computer");
  });

  it("the rail's two circles: this computer's page has the one list; My Cloud's page lists My Cloud's bots only, as with the switch off", async () => {
    window.ogb = { placesTogether: page } as never;
    await render();
    expect(ids('[data-sidebar-section-id="builtin:bots"]')).toEqual(["git", "ledger", "cloud:scout", "cloud:tech"]);
    await act(async () => root.unmount());
    resetPlacesTogetherForTest(); resetPlaceRowsForTest();
    root = createRoot(host);
    const cloudBots = [bot("maus", { chiefOfStaff: true }), bot("scout"), bot("atlas")];
    const offline = await htmlWith(null, cloudBots);
    answer = async () => said({ here: "cloud", other: { home: "computer", state: "ready", bots: [row("git", { home: "computer", unread: true }), row("ledger", { home: "computer" })] } });
    const cloudPage = await htmlWith({ placesTogether: page }, cloudBots);
    answer = async () => said({ here: "cloud", other: { home: "computer", state: "offline", bots: [] } });
    const cloudPageOffline = await htmlWith({ placesTogether: page }, cloudBots);
    expect(cloudPage).toBe(offline);
    expect(cloudPageOffline).toBe(offline);
    expect(cloudPage).not.toContain("computer:");
    expect(cloudPage).not.toContain("data-bot-place");
    expect(cloudPage).not.toContain("data-other-place");
  });

  it("rows of the other place come in at the end and show their marks at once, with the pointer on the list, moving no row", async () => {
    window.ogb = { placesTogether: page } as never;
    let release!: (value: PlacesTogetherState) => void;
    answer = () => new Promise((resolve) => { release = resolve; });
    await render();
    q("aside")!.dispatchEvent(new Event("pointerenter"));
    const local = ids();
    await act(async () => release(said({ other: { home: "cloud", state: "ready", bots: [row("tech", { unread: true, lastAt: 9_000 }), row("scout", { working: true })] } })));
    expect(ids().slice(0, local.length)).toEqual(local);
    expect(ids('[data-sidebar-section-id="builtin:bots"]')).toEqual(["git", "ledger", "cloud:tech", "cloud:scout"]);
    expect(q('[data-sidebar-section-id="builtin:unread"]')).toBeNull();
    // No wait for the list to go quiet: Scout's working mark shows now, in its place.
    expect(q('[data-sidebar-bot-row="cloud:scout"] [data-testid="working-dot"]')).not.toBeNull();
  });

  it("an answer that changes nothing moves nothing: the same rows stay, the same elements", async () => {
    window.ogb = { placesTogether: page } as never;
    await render();
    const before = [...host.querySelectorAll("[data-sidebar-bot-row]")];
    await act(async () => changed());
    await act(async () => { await Promise.resolve(); });
    const after = [...host.querySelectorAll("[data-sidebar-bot-row]")];
    expect(after.length).toBe(before.length);
    after.forEach((element, index) => expect(element).toBe(before[index]));
  });

  it("a row kept from before My Cloud slept is not working: it does not float, and its mark says asleep", async () => {
    window.ogb = { placesTogether: page } as never;
    answer = async () => said({ other: { home: "cloud", state: "asleep", bots: [row("scout", { working: true }), row("atlas")] } });
    await render();
    expect(ids('[data-sidebar-section-id="builtin:bots"]')).toEqual(["git", "ledger", "cloud:scout", "cloud:atlas"]);
    expect(mark("cloud:scout")!.getAttribute("data-bot-place")).toBe("cloud-asleep");
    expect(q('[data-sidebar-bot-row="cloud:scout"] [data-testid="working-dot"]')).toBeNull();
  });

  it("in the avatars-only sidebar a row of the other place keeps a small place badge, in its informative icon while there is one", async () => {
    window.ogb = { placesTogether: page } as never;
    mode.advanced = true;
    answer = async () => said({ other: { home: "cloud", state: "asleep", bots: [row("scout")] } });
    await render(OWN, true);
    expect(q('[data-sidebar-bot-row="cloud:scout"] [data-bot-place-badge]')!.getAttribute("data-bot-place-badge")).toBe("cloud-asleep");
    expect(q('[data-sidebar-bot-row="git"] [data-bot-place-badge]')).toBeNull();
    answer = async () => said({ other: { home: "cloud", state: "ready", bots: [row("scout")] } });
    await act(async () => changed());
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-sidebar-bot-row="cloud:scout"] [data-bot-place-badge]')!.getAttribute("data-bot-place-badge")).toBe("cloud");
  });

  it("a bot moved to My Cloud keeps today's row unless My Cloud's rows already list it", async () => {
    window.ogb = { placesTogether: page } as never;
    const moved = bot("old", { hidden: true, movedTo: { team: { id: "my-cloud", name: "My Cloud" }, state: "moved", at: 1 } } as Partial<Bot>);
    answer = async () => said({ other: { home: "cloud", state: "signin", bots: [] } });
    await render([...OWN, moved]);
    expect(q("[data-moved-to-my-cloud]")).not.toBeNull();
    answer = async () => said({ other: { home: "cloud", state: "ready", bots: [row("old")] } });
    await act(async () => changed());
    await act(async () => { await Promise.resolve(); });
    expect(q("[data-moved-to-my-cloud]")).toBeNull();
    expect(q('[data-sidebar-bot-row="cloud:old"]')).not.toBeNull();
  });

  it("a place that never answers leaves this place's list whole, and the first answer adds its rows without a wait", async () => {
    window.ogb = { placesTogether: page } as never;
    let release!: (value: PlacesTogetherState) => void;
    answer = () => new Promise((resolve) => { release = resolve; });
    await render();
    expect(ids()).toEqual(["mausbot", "git", "ledger"].filter((id) => q(`[data-sidebar-bot-row="${id}"]`)));
    expect(ids('[data-sidebar-section-id="builtin:bots"]')).toEqual(["git", "ledger"]);
    await act(async () => release(said()));
    expect(ids('[data-sidebar-section-id="builtin:bots"]')).toEqual(["git", "ledger", "cloud:scout", "cloud:tech"]);
  });
});
