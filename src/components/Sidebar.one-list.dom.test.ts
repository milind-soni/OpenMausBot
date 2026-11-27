// @vitest-environment happy-dom
// The one list in the real Sidebar: with "This computer and My Cloud together" on, the other place's bots land in a
// department named after their place and can be dragged anywhere from there, and both pages draw the same list; with it
// off, or with main never answering, the sidebar is exactly as it was.
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { ArrangedBot, PlaceBotRow, PlacesTogetherState } from "@/lib/places-together";

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
  arrange: vi.fn(async (entries: ArrangedBot[]) => entries),
};
/** This page's store has loaded (its departments are known for sure). */
let hydrated = false;
const tree = (bots: Bot[], icons = false) => createElement(BotEditorStore, {
  value: { state: { ...initialState, connected: true, bots, selectedId: bots[0]!.id, ...(hydrated ? { hydrated: true as const } : {}) }, dispatch,
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
const OWN_BOTS = '[data-sidebar-section-id="builtin:bots"]', MY_CLOUD = '[data-sidebar-section-id="section:My Cloud"]';
/** The list as drawn: each department heading, then its rows by their own ids (a row's place key left out). */
const drawn = () => [...host.querySelectorAll<HTMLElement>("[data-sidebar-section-id] [data-section], [data-sidebar-section-id] [data-sidebar-bot-row]")]
  .map((element) => element.dataset.section ?? element.dataset.sidebarBotRow!.replace(/^(cloud|computer):/, ""));
function transfer() {
  const data = new Map<string, string>();
  return { data, effectAllowed: "all", dropEffect: "none", get types() { return [...data.keys()]; },
    setData: (type: string, value: string) => { data.set(type, value); }, getData: (type: string) => data.get(type) ?? "", setDragImage: () => {}, files: [], items: [] };
}
function fire(target: Element, type: string, carried: ReturnType<typeof transfer>, clientY = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: carried });
  Object.defineProperty(event, "clientY", { value: clientY });
  flushSync(() => target.dispatchEvent(event));
}
const dragHost = (id: string) => q(`[data-sidebar-bot-row="${id}"]`)?.closest('[draggable="true"]') ?? null;
/** Drags `moving` onto the lower edge of `onto`'s row and lets go. */
/** Each draggable row 50px tall, one under another. */
const rowBoxes = () => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
  const rows = [...document.querySelectorAll('[draggable="true"]')], index = Math.max(0, rows.indexOf(this));
  return { top: index * 50, bottom: index * 50 + 50, height: 50, left: 0, right: 200, width: 200, x: 0, y: index * 50, toJSON: () => ({}) } as DOMRect;
});
/** Drags `moving` onto the middle of `onto`'s row, where a drop starts a department when the page allows it. */
function dragOnto(moving: string, onto: string) {
  const from = dragHost(moving)!, target = dragHost(onto)!, carried = transfer();
  fire(from, "dragstart", carried);
  const box = target.getBoundingClientRect();
  fire(target, "dragover", carried, box.top + box.height / 2);
  fire(target, "drop", carried, box.top + box.height / 2);
  fire(from, "dragend", carried);
}
function dragBelow(moving: string, onto: string) {
  const from = dragHost(moving), target = dragHost(onto), carried = transfer();
  expect(from, `${moving} is draggable`).not.toBeNull();
  expect(target, `${onto} takes a drop`).not.toBeNull();
  fire(from!, "dragstart", carried);
  const box = target!.getBoundingClientRect();
  fire(target!, "dragover", carried, box.bottom - 2);
  fire(target!, "drop", carried, box.bottom - 2);
  fire(from!, "dragend", carried);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  dispatch.mockReset();
  for (const fn of Object.values(page)) fn.mockClear();
  answer = async () => said();
  localStorage.clear();
  hydrated = false;
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
  vi.restoreAllMocks();
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
  for (const advanced of [false, true]) it(`${advanced ? "Advanced" : "Simple"}: My Cloud's bots land in a "My Cloud" department after this computer's departments; this computer's bots stay where they were`, async () => {
    window.ogb = { placesTogether: page } as never;
    mode.advanced = advanced;
    await render([...OWN, bot("finn", { section: "Finance" })]);
    expect(ids(OWN_BOTS)).toEqual(["git", "ledger"]);
    expect(ids(MY_CLOUD)).toEqual(["cloud:scout", "cloud:tech"]);
    expect(drawn().filter((item) => item !== "Bots")).toEqual(["git", "ledger", "Finance", "finn", "My Cloud", "scout", "tech"]);
    expect(q('[data-sidebar-section-id="builtin:unread"]')).toBeNull();
    expect(q("[data-other-place]")).toBeNull();
    expect(q('[data-sidebar-bot-row="cloud:scout"]')!.textContent).toContain("Open issues");
    expect(q('[data-sidebar-bot-row="cloud:tech"]')!.textContent).toContain("Deploy passed on staging.");
  });

  it("unread rows of both places keep their places", async () => {
    window.ogb = { placesTogether: page } as never;
    const nova = bot("nova", { unread: true, tasks: [{ threadId: "nova-t", title: "Chat", createdAt: 1, updatedAt: 5_000, unread: true }] });
    answer = async () => said({ other: { home: "cloud", state: "ready", bots: [row("old", { unread: true, lastAt: 1_000 }), row("tech", { unread: true, lastAt: 9_000 })] } });
    await render([...OWN, nova]);
    expect(ids(OWN_BOTS)).toEqual(["git", "ledger", "nova"]);
    expect(ids(MY_CLOUD)).toEqual(["cloud:old", "cloud:tech"]);
    expect(q('[data-sidebar-section-id="builtin:unread"]')).toBeNull();
  });

  it("a bot with the same id in both places is two rows, each its own", async () => {
    window.ogb = { placesTogether: page } as never;
    answer = async () => said({ other: { home: "cloud", state: "ready", bots: [row("git", { name: "Git there" })] } });
    await render();
    expect(ids(OWN_BOTS)).toEqual(["git", "ledger"]);
    expect(ids(MY_CLOUD)).toEqual(["cloud:git"]);
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

  it("dragging a Cloud bot into another department keeps it there through a restart, and My Cloud's page draws the same list; this computer's server never hears of it", async () => {
    window.ogb = { placesTogether: page } as never;
    const own = [...OWN, bot("finn", { section: "Finance" })];
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => { fetched.push(`${init?.method ?? "GET"} ${url} ${String(init?.body ?? "")}`); return new Promise(() => {}); });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rows = [...document.querySelectorAll('[draggable="true"]')], index = Math.max(0, rows.indexOf(this));
      return { top: index * 50, bottom: index * 50 + 50, height: 50, left: 0, right: 200, width: 200, x: 0, y: index * 50, toJSON: () => ({}) } as DOMRect;
    });
    await render(own);
    expect(q('[data-section="Finance"] [aria-haspopup="menu"]')).not.toBeNull();
    dragBelow("cloud:tech", "finn");
    expect(page.arrange).toHaveBeenCalled();
    const kept = page.arrange.mock.calls.at(-1)![0];
    expect(kept).toEqual(expect.arrayContaining([{ key: "cloud:tech", section: "Finance", after: "computer:finn" }]));
    expect(ids('[data-sidebar-section-id="section:Finance"]')).toEqual(["finn", "cloud:tech"]);
    const afterDrag = drawn();
    expect(JSON.stringify(dispatch.mock.calls)).not.toMatch(/cloud:|computer:/);
    expect(fetched.filter((line) => /cloud:|computer:/.test(line))).toEqual([]);
    // A restart: main hands back what it kept.
    const arranged = page.arrange.mock.calls.flatMap(([entries]) => entries);
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    resetPlacesTogetherForTest(); resetPlaceRowsForTest();
    root = createRoot(host);
    answer = async () => said({ arranged });
    await render(own);
    expect(drawn()).toEqual(afterDrag);
    // The window goes to My Cloud's page: the same list, this computer's bots as rows there.
    await act(async () => root.unmount());
    resetPlacesTogetherForTest(); resetPlaceRowsForTest();
    root = createRoot(host);
    answer = async () => said({ here: "cloud", home: "computer", arranged, other: { home: "computer", state: "ready", sections: ["Finance"], bots: [row("git", { home: "computer" }), row("ledger", { home: "computer" }), row("finn", { home: "computer", section: "Finance" })] } });
    await render([bot("maus", { chiefOfStaff: true }), bot("scout", { title: "Open issues" }), bot("tech")]);
    expect(drawn()).toEqual(afterDrag);
    // There, this computer's rows stay where this computer keeps them; My Cloud's own bots are moved through main.
    expect(dragHost("computer:git")).toBeNull();
    expect(dragHost("scout")).not.toBeNull();
    // Its departments are this computer's: their menus belong to this computer's page.
    expect(q('[data-section="Finance"] [aria-haspopup="menu"]')).toBeNull();
  });

  it("before this page's store has loaded, a Cloud bot is drawn in the department it was kept in, and a drag writes only the bot moved", async () => {
    window.ogb = { placesTogether: page } as never;
    rowBoxes();
    const stored: ArrangedBot[] = [{ key: "cloud:scout", section: "Trips", after: null }, { key: "cloud:old", section: "Finance", after: "computer:finn" }];
    answer = async () => said({ arranged: stored, other: { home: "cloud", state: "asleep", bots: [row("scout"), row("tech"), row("old")] } });
    await render([...OWN, bot("finn", { section: "Finance" })]);
    // "Trips" is not among this computer's departments yet: it is drawn as kept, not sent to "My Cloud".
    expect(ids('[data-sidebar-section-id="section:Trips"]')).toEqual(["cloud:scout"]);
    dragBelow("cloud:tech", "finn");
    const sent = page.arrange.mock.calls.flatMap(([entries]) => entries);
    expect(sent.map((entry) => entry.key)).toEqual(["cloud:tech"]);
    // Every other bot's entry is as it was: main's merge leaves it byte for byte.
    const merged = [...stored.filter((entry) => !sent.some((moved) => moved.key === entry.key)), ...sent];
    expect(JSON.stringify(merged.filter((entry) => entry.key !== "cloud:tech"))).toBe(JSON.stringify(stored));
  });

  it("once this page's store has loaded, a Cloud bot kept in a department this computer no longer has goes back to My Cloud's department", async () => {
    window.ogb = { placesTogether: page } as never;
    hydrated = true;
    answer = async () => said({ arranged: [{ key: "cloud:scout", section: "Trips", after: null }] });
    await render();
    expect(q('[data-sidebar-section-id="section:Trips"]')).toBeNull();
    expect(ids(MY_CLOUD)).toEqual(["cloud:scout", "cloud:tech"]);
  });

  it("on My Cloud's page while this computer is loading, its own bots stay in the departments they were kept in, and a drag writes only the bot moved", async () => {
    window.ogb = { placesTogether: page } as never;
    rowBoxes();
    const stored: ArrangedBot[] = [{ key: "cloud:scout", section: "Finance", after: null }, { key: "cloud:tech", section: "Finance", after: "cloud:scout" }, { key: "cloud:atlas", section: "", after: null }];
    answer = async () => said({ here: "cloud", home: "computer", arranged: stored, other: { home: "computer", state: "loading", bots: [] } });
    await render([bot("maus", { chiefOfStaff: true }), bot("scout"), bot("tech"), bot("atlas")]);
    expect(ids('[data-sidebar-section-id="section:Finance"]')).toEqual(["scout", "tech"]);
    dragBelow("scout", "tech");
    const sent = page.arrange.mock.calls.flatMap(([entries]) => entries);
    expect(sent.map((entry) => entry.key)).toEqual(["cloud:scout"]);
    expect(JSON.stringify(stored.filter((entry) => entry.key !== "cloud:scout"))).toBe(JSON.stringify([stored[1], stored[2]]));
  });

  it("on My Cloud's page a bot dropped on another never starts a department; on this computer's page it does", async () => {
    window.ogb = { placesTogether: page } as never;
    rowBoxes();
    answer = async () => said({ here: "cloud", home: "computer", other: { home: "computer", state: "ready", bots: [row("git", { home: "computer" })] }, arranged: [{ key: "cloud:scout", section: "", after: null }, { key: "cloud:tech", section: "", after: "cloud:scout" }] });
    await render([bot("maus", { chiefOfStaff: true }), bot("scout"), bot("tech")]);
    dragOnto("tech", "scout");
    expect(q("[data-section-name-field]")).toBeNull();
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    resetPlacesTogetherForTest(); resetPlaceRowsForTest();
    root = createRoot(host);
    rowBoxes();
    answer = async () => said();
    await render();
    dragOnto("ledger", "git");
    expect(q("[data-section-name-field]")).not.toBeNull();
  });

  it("starting a department from Cloud bots: a failed make stores nothing; a department main will not fill is taken away again", async () => {
    window.ogb = { placesTogether: page } as never;
    rowBoxes();
    const calls: string[] = [];
    let make: "fail" | "ok" = "fail";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST" && make === "fail") return new Response(JSON.stringify({ error: "nope" }), { status: 500, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ sections: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    answer = async () => said({ arranged: [{ key: "cloud:scout", section: "", after: "computer:ledger" }, { key: "cloud:tech", section: "", after: "cloud:scout" }] });
    await render();
    const name = async () => { const field = q("[data-section-name-field]")!; await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }); await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); };
    dragOnto("cloud:tech", "cloud:scout");
    await name();
    expect(calls.filter((call) => call.startsWith("POST /api/sidebar-sections"))).toHaveLength(1);
    expect(page.arrange).not.toHaveBeenCalled();
    // The make works, but main keeps nothing (here: it hands back what it had): the empty department is deleted again.
    make = "ok";
    page.arrange.mockImplementationOnce(async () => []);
    dragOnto("cloud:tech", "cloud:scout");
    await name();
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(page.arrange).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.startsWith("DELETE /api/sidebar-sections?section="))).toBe(true);
  });

  it("home is My Cloud and main's copy of its departments is behind: a drag on this computer's page leaves the \"Design\" entries byte for byte", async () => {
    window.ogb = { placesTogether: page } as never;
    rowBoxes();
    // "Design" was just made on My Cloud's page and the computer's bots dragged into it; main has not read My Cloud since.
    const stored: ArrangedBot[] = [{ key: "computer:git", section: "Design", after: null }, { key: "computer:ledger", section: "Design", after: "computer:git" }];
    answer = async () => said({ here: "computer", home: "cloud", arranged: stored, other: { home: "cloud", state: "ready", sections: ["Research"], bots: [row("scout")] } });
    await render([bot("mausbot", { chiefOfStaff: true }), bot("git"), bot("ledger"), bot("finn")]);
    expect(ids('[data-sidebar-section-id="section:This computer"]')).toEqual(["git", "ledger", "finn"]);
    dragBelow("finn", "git");
    const sent = page.arrange.mock.calls.flatMap(([entries]) => entries);
    expect(sent.map((entry) => entry.key)).toEqual(["computer:finn"]);
    const merged = [...stored.filter((entry) => !sent.some((moved) => moved.key === entry.key)), ...sent];
    expect(JSON.stringify(merged.filter((entry) => entry.key !== "computer:finn"))).toBe(JSON.stringify(stored));
  });

  it("renaming My Cloud's department to a department this computer already has never takes that department away when main will not keep it", async () => {
    window.ogb = { placesTogether: page } as never;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify({ sections: ["Finance"] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    page.arrange.mockImplementation(async () => []);
    await render([...OWN, bot("finn", { section: "Finance" })]);
    await act(async () => q('[data-section="My Cloud"] [aria-haspopup="menu"]')!.click());
    const rename = [...document.body.querySelectorAll<HTMLElement>("[role=menuitem]")].find((item) => item.textContent === "Rename department")!;
    await act(async () => rename.click());
    const field = q("[data-section-name-field]") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Finance");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(page.arrange).toHaveBeenCalled();
    expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual([]);
    expect(ids('[data-sidebar-section-id="section:Finance"]')).toContain("finn");
  });

  it("an older app that does not say which place is home leaves My Cloud's page as it was: its own bots only", async () => {
    const cloudBots = [bot("maus", { chiefOfStaff: true }), bot("scout", { section: "Research" }), bot("atlas")];
    const browser = await htmlWith(null, cloudBots);
    answer = async () => said({ here: "cloud", other: { home: "computer", state: "ready", bots: [row("git", { home: "computer" }), row("ledger", { home: "computer" })] } });
    const { arrange: _newer, ...older } = page;
    expect(await htmlWith({ placesTogether: older }, cloudBots)).toBe(browser);
    expect(browser).toContain("Research");
  });

  it("the place's own department, which only the app keeps, offers no menu item that would name it to this computer's server", async () => {
    window.ogb = { placesTogether: page } as never;
    await render([...OWN, bot("finn", { section: "Finance" })]);
    const menuOf = async (name: string) => {
      await act(async () => q(`[data-section="${name}"] [aria-haspopup="menu"]`)!.click());
      const items = [...document.body.querySelectorAll<HTMLElement>("[role=menuitem]")];
      const said = { share: items.some((item) => item.textContent === "Share"), read: items.some((item) => item.hasAttribute("data-team-mark-read") || item.hasAttribute("data-team-pause")), rename: items.some((item) => item.textContent === "Rename department") };
      await act(async () => { document.body.querySelector("[role=menu]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      return said;
    };
    expect((await menuOf("Finance")).share).toBe(true);
    expect(await menuOf("My Cloud")).toEqual({ share: false, read: false, rename: true });
  });

  it("a new Cloud bot lands in My Cloud's department; one already placed stays put", async () => {
    window.ogb = { placesTogether: page } as never;
    answer = async () => said({ arranged: [{ key: "cloud:scout", section: "", after: "computer:git" }],
      other: { home: "cloud", state: "ready", bots: [row("scout"), row("tech"), row("nova")] } });
    await render();
    expect(ids(OWN_BOTS)).toEqual(["git", "cloud:scout", "ledger"]);
    expect(ids(MY_CLOUD)).toEqual(["cloud:tech", "cloud:nova"]);
  });

  it("with My Cloud as home, this computer's bots land in a \"This computer\" department on either page", async () => {
    window.ogb = { placesTogether: page } as never;
    answer = async () => said({ here: "computer", home: "cloud", other: { home: "cloud", state: "ready", bots: [row("scout"), row("tech")] } });
    await render();
    expect(ids(OWN_BOTS)).toEqual(["cloud:scout", "cloud:tech"]);
    expect(ids('[data-sidebar-section-id="section:This computer"]')).toEqual(["git", "ledger"]);
  });

  it("rows of the other place come in below this place's own and show their marks at once, with the pointer on the list, moving no row", async () => {
    window.ogb = { placesTogether: page } as never;
    let release!: (value: PlacesTogetherState) => void;
    answer = () => new Promise((resolve) => { release = resolve; });
    await render();
    q("aside")!.dispatchEvent(new Event("pointerenter"));
    const local = ids();
    await act(async () => release(said({ other: { home: "cloud", state: "ready", bots: [row("tech", { unread: true, lastAt: 9_000 }), row("scout", { working: true })] } })));
    expect(ids().slice(0, local.length)).toEqual(local);
    expect(ids(OWN_BOTS)).toEqual(["git", "ledger"]);
    expect(ids(MY_CLOUD)).toEqual(["cloud:tech", "cloud:scout"]);
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
    expect(ids(MY_CLOUD)).toEqual(["cloud:scout", "cloud:atlas"]);
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
    expect(ids(OWN_BOTS)).toEqual(["git", "ledger"]);
    expect(ids(MY_CLOUD)).toEqual(["cloud:scout", "cloud:tech"]);
  });
});
