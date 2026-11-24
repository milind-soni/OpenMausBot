// Dev-only gallery of one list of bots across This computer and My Cloud, served at /unified-sidebar-preview.html; not in
// the packaged app. It mounts the real sidebar (and, for today's look, the real rail) over a fixed store and fake bridges.
// ?state=today|today-asleep|today-plus|idle|hover|working|asleep|computer-off|handoff|plus|sheet&variant=hover|faint
// &skin=midnight|daylight
import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { RailState } from "../electron/cloud-rail.mjs";
import type { PlaceBotRow, PlacesTogetherState } from "../electron/places-together.mjs";
import { PlacesRail } from "@/components/PlacesRail";
import { BotListItem, botRowProps, Sidebar } from "@/components/Sidebar";
import { setAdvancedMode } from "@/lib/interface-mode";
import { loadLocale } from "@/lib/i18n";
import { placeMark, setBotPlaces, type BotWhere, type Place } from "@/lib/bot-place";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import { initialState, StoreContext, type AppState, type Bot, type Message } from "@/state/store";
import "./styles.css";

const params = new URLSearchParams(location.search);
const view = params.get("state") ?? "idle";
const variant = params.get("variant") === "faint" ? "faint" : "hover";
const skin = params.get("skin") ?? "midnight";
setAdvancedMode(false);
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");
await loadLocale("en");

const today = view.startsWith("today");
const fromCloud = view === "computer-off";
const NOW = Date.now();
const AT = NOW - 50 * 60_000;

const computer: Place = { key: "mac", device: "laptop", name: fromCloud ? "Sam's MacBook" : "This computer", health: fromCloud ? "offline" : "ready", here: !fromCloud };
const cloud: Place = { key: "cloud", device: "cloud", name: "My Cloud", health: view === "asleep" ? "asleep" : "ready", here: false };

const message = (id: string, minutes: number, fields: Partial<Message>): Message =>
  ({ id, at: AT + minutes * 60_000, role: "bot", kind: "text", text: "", ...fields }) as Message;

interface Fixture { id: string; name: string; color: string; home: "computer" | "cloud"; title?: string; line: string; minutes: number; chief?: boolean; unread?: boolean; working?: boolean; mascotBody?: string }
const FIXTURES: Fixture[] = [
  { id: "mausbot", name: "MausBot", color: "green", home: "computer", line: "Morning. Three things need you today.", minutes: 48, chief: true },
  { id: "git-tasks", name: "Git Tasks", color: "orange", home: "computer", line: "Pushed the fix to the release branch.", minutes: 30 },
  { id: "ledger", name: "Ledger", color: "blue", home: "computer", line: "The March invoices are filed in your Drive.", minutes: 12 },
  { id: "tech", name: "Technical Assistant", color: "purple", home: "cloud", line: "The deploy check passed on the second try.", minutes: 40, unread: true },
  { id: "scout", name: "Scout", color: "teal", home: "cloud", line: "Five new issues since yesterday.", minutes: 22 },
  { id: "atlas", name: "Atlas", color: "pink", home: "cloud", line: "Booked: the 9:40 train to Leeds on Friday.", minutes: 5 },
];

function botOf(fixture: Fixture, overrides: Partial<Bot> = {}, text = fixture.line): Bot {
  const thread = `${fixture.id}-main`;
  const working = Boolean(overrides.busy);
  return {
    title: fixture.title ?? "", description: "", notifications: true, unread: fixture.unread === true, modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    id: fixture.id, name: fixture.name, color: fixture.color, threadId: thread, mainThreadId: thread, busy: false, activity: working ? "working" : "idle",
    chiefOfStaff: fixture.chief === true,
    tasks: [{ threadId: thread, title: fixture.name, createdAt: AT, ...(fixture.unread ? { unread: true } : {}), ...(working ? { busy: true, activity: "working" } : {}) }],
    messages: [message(`${fixture.id}-1`, fixture.minutes, { text })],
    ...overrides,
  } as Bot;
}

/** What each bot says in this state, and where it is. */
function scene(): { bots: Bot[]; where: Map<string, BotWhere> } {
  const where = new Map<string, BotWhere>();
  const bots: Bot[] = [];
  for (const fixture of FIXTURES) {
    const home = fixture.home === "cloud" ? cloud : computer;
    let bot = botOf(fixture);
    const place: BotWhere = { home };
    if (view === "working" && fixture.id === "scout") { bot = botOf(fixture, { busy: true }, "Reading the open issues…"); place.working = true; }
    if (view === "handoff" && fixture.id === "tech") { bot = botOf(fixture, { busy: true }, "Git Tasks is pushing the branch on this computer…"); place.working = true; place.workingAt = computer; }
    if (view === "handoff" && fixture.id === "git-tasks") { bot = botOf(fixture, { busy: true }, "Pushing the release branch for Technical Assistant…"); place.working = true; }
    if (view === "computer-off" && fixture.id === "tech") { bot = botOf(fixture, {}, "Waiting for Sam's MacBook to run the tests there."); place.waitingFor = computer; }
    where.set(bot.id, place);
    bots.push(bot);
  }
  return { bots, where };
}

/** Today's other place, as main hands it to the page: rows under a group of their own. */
function rowOf(fixture: Fixture): PlaceBotRow {
  return { home: "cloud", id: fixture.id, threadId: `${fixture.id}-main`, name: fixture.name, color: fixture.color, ...(fixture.unread ? { unread: true as const } : {}) };
}

const { bots: all, where } = scene();
const computerBots = all.filter((bot) => FIXTURES.find((fixture) => fixture.id === bot.id)?.home === "computer");
const cloudFixtures = FIXTURES.filter((fixture) => fixture.home === "cloud");
const together: PlacesTogetherState = { v: 1, available: true, on: true, here: "computer",
  other: { home: "cloud", state: view === "today-asleep" ? "asleep" : "ready", bots: cloudFixtures.map(rowOf), newBot: true } };

const rail: RailState = { places: [
  { id: "local", name: "This computer", color: null, kind: "computer", opens: true, active: true, paint: { swatch: null } },
  { id: "cloud", name: "My Cloud", color: "blue", kind: "cloud", opens: true, paint: { swatch: "blue" } },
], add: { cloud: false, link: true, address: false } } as unknown as RailState;

Object.assign(window, { ogb: {
  ...(today ? {
    placesTogether: {
      state: async () => together, set: async () => together, open: async () => true, onChanged: () => () => {},
      newBotChoice: async () => ({ home: "cloud", state: together.other!.state, ais: [{ name: "Claude", kind: "claudeCode" }] }), newBot: async () => true, onNewBot: () => () => {},
    },
  } : {}),
  workspaces: { places: async () => rail, state: async () => ({ local: true, name: "This computer" }), menu: async () => {}, open: async () => {}, add: async () => {}, onChanged: () => () => {} },
  rail: { expand: async () => {}, onSkin: () => () => {} },
} });
setBotPlaces(today ? null : where, variant);

function storeValue(bots: Bot[], selectedId: string | null): { state: AppState; dispatch: () => void; flushBotPatches: () => Promise<null>; refreshInstances: () => Promise<void>; refreshModels: () => Promise<void> } {
  const state: AppState = { ...initialState, bots, selectedId: selectedId ?? "", activeView: "chat", connected: true,
    config: { ...initialState.config, profile: { name: "Sam", email: "", aboutMe: "" } } as AppState["config"] };
  return { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh w-full overflow-hidden bg-app text-ink">{children}</div>;
}

/** The window as the person sees it: today with the rail of places beside the list, the proposal with one list only. */
function Window() {
  const bots = today ? computerBots : all;
  const value = storeValue(bots, "ledger");
  useEffect(() => {
    // The pictures wait for this mark: the page settled, and a menu that opens has finished its motion.
    const settle = () => window.setTimeout(() => { document.body.dataset.previewReady = "1"; }, 700);
    if (view !== "plus" && view !== "today-plus") { const done = settle(); return () => clearTimeout(done); }
    const timer = setInterval(() => {
      if (document.querySelector('[role="menu"]')) { clearInterval(timer); settle(); return; }
      document.querySelector<HTMLButtonElement>('[data-sidebar-top-buttons] .contents > button')?.click();
    }, 150);
    return () => clearInterval(timer);
  }, []);
  return (
    <StoreContext.Provider value={value}>
      <Frame>
        {today && <div className="relative flex w-[44px] shrink-0 flex-col items-center border-e border-hairline/60 bg-panel pt-10 max-md:hidden"><PlacesRail chrome /></div>}
        <div className="flex h-full w-[300px] shrink-0 max-md:w-full" data-preview={view}><Sidebar open onClose={() => {}} /></div>
        <div className="min-w-0 flex-1 bg-canvas max-md:hidden" />
      </Frame>
    </StoreContext.Provider>
  );
}

/** Every state's row side by side, large enough to read: the picture to look at first. */
const SHEET: Array<{ label: string; place: BotWhere; bot: Bot; hover?: boolean }> = (() => {
  const base = (id: string) => FIXTURES.find((fixture) => fixture.id === id)!;
  const asleepCloud: Place = { ...cloud, health: "asleep" };
  const offMac: Place = { ...computer, name: "Sam's MacBook", health: "offline", here: false };
  const studio: Place = { key: "studio", device: "desktop", name: "Studio Mac", health: "ready" };
  let next = 0;
  const as = (id: string, name: string) => ({ ...base(id), id: `sheet-${next++}-${id}`, name });
  return [
    { label: "Idle, lives on this computer", place: { home: computer }, bot: botOf(as("git-tasks", "Git Tasks")) },
    { label: "Idle, lives on My Cloud", place: { home: cloud }, bot: botOf(as("scout", "Scout")) },
    { label: "Pointer over the row (or keyboard focus)", place: { home: cloud }, bot: botOf(as("atlas", "Atlas")), hover: true },
    { label: "Lives on another computer of yours", place: { home: studio }, bot: botOf(as("ledger", "Render"), {}, "Finished the 4K export.") },
    { label: "Working on My Cloud now", place: { home: cloud, working: true }, bot: botOf(as("scout", "Scout"), { busy: true }, "Reading the open issues…") },
    { label: "Cloud bot, its work runs on this computer", place: { home: cloud, working: true, workingAt: computer }, bot: botOf(as("tech", "Technical Assistant"), { busy: true }, "Git Tasks is pushing the branch here…") },
    { label: "My Cloud asleep (normal, not an error)", place: { home: asleepCloud }, bot: botOf(as("atlas", "Atlas")) },
    { label: "Waiting for a computer that is off", place: { home: cloud, waitingFor: offMac }, bot: botOf(as("tech", "Technical Assistant"), {}, "Waiting for Sam's MacBook to run the tests there.") },
    { label: "Lives on a computer that is off", place: { home: offMac }, bot: botOf(as("git-tasks", "Git Tasks")) },
  ];
})();

function Sheet() {
  const bots = SHEET.map((entry) => entry.bot);
  const value = storeValue(bots, null);
  useEffect(() => {
    setBotPlaces(new Map(SHEET.map((entry) => [entry.bot.id, entry.place])), variant);
    const done = window.setTimeout(() => { document.body.dataset.previewReady = "1"; }, 700);
    return () => clearTimeout(done);
  }, []);
  const rowFor = (bot: Bot) => botRowProps(value.state, value.dispatch, bot, { density: "comfortable", query: "", onMenu: () => {}, renameRequest: 0 });
  return (
    <StoreContext.Provider value={value}>
      <div className="min-h-dvh bg-app p-8 text-ink" data-preview="sheet">
        <h1 className="mb-1 text-[17px] font-semibold">One list: where each bot is</h1>
        <p className="mb-6 text-[13px] text-ink-secondary">{variant === "faint" ? "Variant B: a faint icon on every row, full strength on hover." : "Variant A (recommended): the icon appears on hover, and stays only while it says something."}</p>
        <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
          {SHEET.map((entry) => (
            <div key={entry.bot.id} className="rounded-2xl border border-hairline/60 bg-panel p-3">
              <div className="mb-2 px-1 text-[12px] font-medium text-ink-secondary">{entry.label}</div>
              <div className={entry.hover ? "preview-hover" : undefined} data-sheet-hover={entry.hover ? "" : undefined}><BotListItem {...rowFor(entry.bot)} /></div>
              <div className="mt-1 px-1 text-[12px] text-ink-tertiary">Tooltip and screen reader: “{placeMark(entry.bot, entry.place).label}”{placeMark(entry.bot, entry.place).shows === "always" ? " · always shown" : " · on hover"}</div>
            </div>
          ))}
        </div>
      </div>
    </StoreContext.Provider>
  );
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!new URL(url, location.href).pathname.startsWith("/api/")) return realFetch(input, init);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

/** Before and after side by side: each column is the real page in a frame of its own (each with its own bridges), cut to
 * the list and enlarged. A pointer target over the hovered column lets the picture tool rest the pointer on that row. */
const COMPARE: Record<string, Array<{ label: string; state: string; hover?: string }>> = {
  "1": [{ label: "Today: two groups, rail of places", state: "today" }, { label: "Proposed: one list, at rest", state: "idle" }, { label: "Proposed: pointer on Scout", state: "idle", hover: "scout" }],
  "2": [{ label: "Today: My Cloud asleep", state: "today-asleep" }, { label: "Proposed: My Cloud asleep", state: "asleep" }, { label: "Proposed: hand-off in progress", state: "handoff" }],
  "3": [{ label: "Today: the ＋ asks where", state: "today-plus" }, { label: "Proposed: one New bot, place at its end", state: "plus" }, { label: "Proposed: working on My Cloud", state: "working" }],
  "4": [{ label: "Proposed: seen from My Cloud, the MacBook off", state: "computer-off" }, { label: "Variant B: faint icon on every row", state: "idle&variant=faint" }, { label: "Variant A: icon on hover only", state: "idle" }],
};
const SCALE = 1.15;

function Compare() {
  const columns = COMPARE[params.get("set") ?? "1"] ?? COMPARE["1"]!;
  useEffect(() => {
    const timer = setInterval(() => {
      const frames = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-compare]")];
      if (!frames.every((frame) => frame.contentDocument?.body?.dataset.previewReady)) return;
      clearInterval(timer);
      frames.forEach((frame, index) => {
        const row = columns[index]?.hover ? frame.contentDocument!.querySelector(`[data-sidebar-bot-row="${columns[index]!.hover}"]`) : null;
        if (!row) return;
        const outer = frame.getBoundingClientRect(), inner = row.getBoundingClientRect();
        const target = document.getElementById("hover-target")!;
        Object.assign(target.style, { left: `${outer.left + inner.left * SCALE}px`, top: `${outer.top + inner.top * SCALE}px`, width: `${inner.width * SCALE}px`, height: `${inner.height * SCALE}px` });
      });
      document.body.dataset.previewReady = "1";
    }, 200);
    return () => clearInterval(timer);
  }, [columns]);
  return (
    <div className="flex h-dvh gap-4 overflow-hidden bg-app p-4 text-ink" data-preview="compare">
      {columns.map((column) => (
        <div key={column.label + column.state} className="flex min-w-0 flex-1 flex-col">
          <div className="mb-2 text-[14px] font-semibold">{column.label}</div>
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-hairline/60">
            <iframe data-compare="" title={column.label} src={`/unified-sidebar-preview.html?state=${column.state}&skin=${skin}`}
              style={{ width: 800, height: `${100 / SCALE}%`, transform: `scale(${SCALE})`, transformOrigin: "top left", border: 0 }} />
          </div>
        </div>
      ))}
      <div id="hover-target" className="pointer-events-none fixed" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode>{view === "sheet" ? <Sheet /> : view === "compare" ? <Compare /> : <Window />}</StrictMode>);
