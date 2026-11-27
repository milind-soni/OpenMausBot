// Dev-only gallery of "This computer and My Cloud together" on by default, served at /together-preview.html; not in the
// packaged app. It mounts the real rail, sidebar and notice over fake bridges, with no server behind them.
// ?view=before|after|notice|notice-cloud-home|notice-off|rail-before|rail-after|rail-cloud-home&mode=simple|advanced&skin=midnight|daylight&lang=pt-br
// What's new, with the notice as its last slide: ?view=whats-new|whats-new-commands|whats-new-off|whats-new-cloud-home
//   &slide=1..6 (the slide on screen) &who=team (a plan and a team: the Cloud's and the team's news) |own (a plan of one's
//   own: Start a Team) |none (no plan: the selling Cloud and Team slides) |admin (a Team Cloud's Owner or Admin on its page:
//   Invite your team) &together=0 (main does not call the notice due)
// The one list: ?page=cloud (My Cloud's own page), ?home=cloud (the person's home is My Cloud),
// ?other=asleep|waking|offline|signin (the other place lists no rows and says why), and ?arranged=1 (the person dragged
// Scout under Git Tasks and Atlas into Finance).
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { CloudAccountState } from "../electron/cloud-account.mjs";
import type { CloudOffer } from "../electron/cloud-home.mjs";
import type { RailState } from "../electron/cloud-rail.mjs";
import type { BotHome, PlaceBotRow, PlacesTogetherState } from "../electron/places-together.mjs";
import { PlacesRail } from "@/components/PlacesRail";
import { Sidebar } from "@/components/Sidebar";
import { TogetherNotice } from "@/components/TogetherNotice";
import { WhatsNewPopup } from "@/components/whats-new/WhatsNewPopup";
import { whatsNewAudience, whatsNewCarousel, whatsNewView } from "@/lib/whats-new";
import { loadLocale } from "@/lib/i18n";
import { setAdvancedMode } from "@/lib/interface-mode";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import { initialState, StoreContext, type AppState, type Bot, type Message } from "@/state/store";
import "./styles.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "notice";
const skin = params.get("skin") ?? "midnight";
setAdvancedMode(params.get("mode") === "advanced");
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");
await loadLocale(params.get("lang") ?? "en");

const AT = Date.now() - 40 * 60_000;
const said = (id: string, minutes: number, text: string): Message => ({ id, at: AT + minutes * 60_000, role: "bot", kind: "text", text }) as Message;
const here = (id: string, name: string, color: string, title: string, line: string, over: Partial<Bot> = {}): Bot => ({
  title: "", description: "", notifications: true, unread: false, modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
  id, name, color, threadId: `${id}-main`, mainThreadId: `${id}-main`, busy: false, activity: "idle",
  tasks: [{ threadId: `${id}-main`, title, createdAt: AT, updatedAt: AT + 5 * 60_000 }], messages: [said(`${id}-1`, 5, line)], ...over,
}) as Bot;
const page: BotHome = params.get("page") === "cloud" ? "cloud" : "computer", homePlace: BotHome = params.get("home") === "cloud" ? "cloud" : "computer";
const otherState = (["asleep", "waking", "offline", "signin"] as const).find((name) => name === params.get("other")) ?? null;
// Each place's own bots: the page's are its store, the other place's come as rows. Each place has its own MausBot: the
// tile on its own page, and a row (first, as main lists it) among its rows on the other page.
const chief = here("mausbot", "MausBot", "violet", "Today", "Your week is planned; three things need you.", { chiefOfStaff: true } as Partial<Bot>);
const computerBots: Bot[] = [
  here("ledger", "Ledger", "orange", "Invoices", "The March invoices are filed in your Drive.", { section: "Finance" }),
  here("git", "Git Tasks", "teal", "Release notes", "Release notes drafted from the last 40 commits."),
];
const cloudBots: Bot[] = [
  here("scout", "Scout", "blue", "Flat hunt", "Found four flats under budget near the park."),
  here("atlas", "Atlas", "green", "Trip", "Booked: the 9:40 train to Leeds on Friday.", { unread: true }),
];
const bots: Bot[] = [chief, ...(page === "cloud" ? cloudBots : computerBots)];
const rowOf = (home: BotHome, bot: Bot): PlaceBotRow => ({ home, id: bot.id, threadId: bot.threadId, name: bot.name, color: bot.color, lastAt: AT + 20 * 60_000,
  preview: (bot.messages[0] as { text: string }).text, chat: bot.tasks?.[0]?.title, ...(bot.section ? { section: bot.section } : {}), ...(bot.unread ? { unread: true as const } : {}), ...(bot.chiefOfStaff ? { chief: true as const } : {}) });
const otherHome: BotHome = page === "cloud" ? "computer" : "cloud";
const otherRows: PlaceBotRow[] = otherState ? [] : [chief, ...(page === "cloud" ? computerBots : cloudBots)].map((bot) => rowOf(otherHome, bot));
const whatsNew = view.startsWith("whats-new");
const joined = !["before", "rail-before"].includes(view) && view !== "notice-off";
const together: PlacesTogetherState = joined
  ? { v: 1, available: true, on: true, here: page, home: homePlace, arranged: params.get("arranged") ? [{ key: "cloud:scout", section: "", after: "computer:git" }, { key: "cloud:atlas", section: "Finance", after: "computer:ledger" }] : [],
    other: { home: otherHome, state: otherState ?? "ready", bots: otherRows, ...(page === "cloud" ? { sections: ["Finance"] } : {}), newBot: true }, ...(view.startsWith("notice") || whatsNew
    ? { notice: true, commands: view === "whats-new-commands", ...(view.endsWith("cloud-home") ? { profileHome: true as const } : {}) } : {}) }
  : { v: 1, available: true, on: false, here: page, other: null, ...(view === "notice-off" ? { notice: true, commands: false } : {}) };

const cloudHome = view === "rail-cloud-home" || homePlace === "cloud";
const rail: RailState = { places: cloudHome ? [
  { id: "profile:default", name: "This computer", color: null, kind: "computer", profile: "default", opens: true, ...(page === "computer" ? { active: true } : {}), paint: { swatch: null }, together: true },
  { id: "home", name: "My Cloud", color: "purple", kind: "cloud", opens: true, ...(page === "cloud" ? { active: true } : {}), paint: { swatch: "violet" }, together: true },
] : [
  { id: "local", name: "This computer", color: null, kind: "computer", opens: true, ...(page === "computer" ? { active: true } : {}), paint: { swatch: null }, ...(view === "rail-before" ? {} : { together: joined }) },
  { id: "home", name: "My Cloud", color: "purple", kind: "cloud", opens: true, ...(page === "cloud" ? { active: true } : {}), paint: { swatch: "violet" }, ...(view === "rail-before" ? {} : { together: joined }) },
], add: { cloud: true, link: true, address: false } };

let state = together;
Object.assign(window, { ogb: {
  platform: "darwin",
  placesTogether: {
    state: async () => state, set: async (on: boolean) => (state = { ...state, on, other: on ? together.other : null }), open: async () => true, onChanged: () => () => {},
    newBotChoice: async () => null, newBot: async () => true, onNewBot: () => () => {}, noticeShown: async () => true, noticeDone: async () => {}, setCommands: async (on: boolean) => on,
  },
  workspaces: { places: async () => rail, state: async () => ({ local: true, name: "This computer" }), menu: async () => {}, open: async () => {}, add: async () => {}, together: async (on: boolean) => on, onChanged: () => () => {} },
  rail: { expand: async () => {}, onSkin: () => () => {} },
} });

const OFFER: CloudOffer = { recommended: "pro", refundDays: 14, plans: [
  { tier: "starter", label: "Starter", amount: 1500 }, { tier: "pro", label: "Pro", amount: 4900 }, { tier: "max", label: "Max", amount: 9900 },
  { tier: "team", label: "Team", amount: 4000, trialDays: 1 },
] };
const who = params.get("who") ?? "team";
const ACCOUNT: CloudAccountState = { status: "connected", account: { id: "a", email: "sam@example.test" }, ...(who === "none"
  ? { entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } }
  : { entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: AT + 30 * 86_400_000, version: 2 },
    ...(who === "team" ? { teams: [{ id: "t1", name: "Design Studio", role: "member" as const, machine: null }] } : {}) }) };
const admin = who === "admin", audience = whatsNewAudience(ACCOUNT);
const carousel = whatsNew ? whatsNewCarousel({ plans: admin ? "none" : whatsNewView(ACCOUNT, OFFER), teamSold: true,
  cloud: admin || audience === "own" || audience === "team", apps: { place: admin ? "cloud" : "computer", install: !admin },
  together: !admin && audience !== "none" && params.get("together") !== "0",
  team: admin ? { kind: "invite", url: "https://cloud.openmausbot.com/team/t1/people?invite=1" } : who === "team" ? { kind: "got-it" } : { kind: "start", inApp: who === "own", url: "" } }) : null;
const noop = () => {};

/** The slide asked for, as the person gets there: its dot; and the list switch turned off for whats-new-off. */
function useWalk() {
  useEffect(() => {
    if (!whatsNew) return;
    let steps = Math.max(0, Number(params.get("slide") ?? 1) - 1), off = view === "whats-new-off";
    const timer = setInterval(() => {
      if (!document.querySelector("[data-whats-new]")) return;
      if (off) { document.querySelector<HTMLElement>("[data-whats-new-slide]:not([inert]) [data-together-notice-list]")?.click(); off = false; return; }
      if (steps-- > 0) { document.querySelector<HTMLElement>("[data-whats-new] button[aria-current]")?.nextElementSibling?.dispatchEvent(new MouseEvent("click", { bubbles: true })); return; }
      clearInterval(timer);
      setTimeout(() => { document.documentElement.dataset.walked = "1"; }, 600);
    }, 150);
    return () => clearInterval(timer);
  }, []);
}

function Gallery() {
  useWalk();
  const state: AppState = { ...initialState, bots, sections: page === "cloud" ? [] : ["Finance"], selectedId: page === "cloud" ? "atlas" : "ledger", connected: true, config: { ...initialState.config, profile: { name: "Sam", email: "", aboutMe: "" } } as AppState["config"] };
  const value = { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  useEffect(() => {
    if (!view.startsWith("rail-")) return;
    const id = view === "rail-cloud-home" ? "profile:default" : "local";
    const timer = setInterval(() => {
      const circle = document.querySelector(`[data-rail-place="${id}"]`);
      if (!circle || document.querySelector("[data-rail-menu]")) return;
      circle.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    }, 100);
    return () => clearInterval(timer);
  }, []);
  return (
    <StoreContext.Provider value={value}>
      <div className="flex h-dvh w-full overflow-hidden bg-app text-ink" data-preview={view}>
        <div className="relative flex w-[44px] shrink-0 flex-col items-center border-e border-hairline/60 bg-sidebar pt-3 max-sm:hidden"><PlacesRail chrome /></div>
        <div className="flex h-full w-[280px] shrink-0 max-sm:w-full"><Sidebar open onClose={() => {}} /></div>
        <div className="min-w-0 flex-1 bg-canvas max-sm:hidden" />
        {view.startsWith("notice") && <TogetherNotice onClose={() => {}} />}
        {carousel && typeof carousel === "object" && <WhatsNewPopup view={carousel} report={noop} onBuy={noop} onOpenApps={noop} onDone={noop} />}
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

createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>);
