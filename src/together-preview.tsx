// Dev-only gallery of "This computer and My Cloud together" on by default, served at /together-preview.html; not in the
// packaged app. It mounts the real rail, sidebar and notice over fake bridges, with no server behind them.
// ?view=before|after|notice|notice-cloud-home|notice-off|rail-before|rail-after|rail-cloud-home&mode=simple|advanced&skin=midnight|daylight&lang=pt-br
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { RailState } from "../electron/cloud-rail.mjs";
import type { PlaceBotRow, PlacesTogetherState } from "../electron/places-together.mjs";
import { PlacesRail } from "@/components/PlacesRail";
import { Sidebar } from "@/components/Sidebar";
import { TogetherNotice } from "@/components/TogetherNotice";
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
const bots: Bot[] = [
  here("mausbot", "MausBot", "violet", "Today", "Your week is planned; three things need you.", { chiefOfStaff: true } as Partial<Bot>),
  here("ledger", "Ledger", "orange", "Invoices", "The March invoices are filed in your Drive."),
  here("git", "Git Tasks", "teal", "Release notes", "Release notes drafted from the last 40 commits."),
];
const row = (id: string, name: string, color: string, over: Partial<PlaceBotRow> = {}): PlaceBotRow => ({ home: "cloud", id, threadId: `${id}-main`, name, color, lastAt: AT + 20 * 60_000, ...over });
const cloudRows: PlaceBotRow[] = [
  row("scout", "Scout", "blue", { preview: "Found four flats under budget near the park.", chat: "Flat hunt" }),
  row("atlas", "Atlas", "green", { preview: "Booked: the 9:40 train to Leeds on Friday.", chat: "Trip", unread: true }),
];
const joined = !["before", "rail-before"].includes(view) && view !== "notice-off";
const together: PlacesTogetherState = joined
  ? { v: 1, available: true, on: true, here: "computer", other: { home: "cloud", state: "ready", bots: cloudRows, newBot: true }, ...(view.startsWith("notice") ? { notice: true, commands: false, ...(view === "notice-cloud-home" ? { profileHome: true as const } : {}) } : {}) }
  : { v: 1, available: true, on: false, here: "computer", other: null, ...(view === "notice-off" ? { notice: true, commands: false } : {}) };

const cloudHome = view === "rail-cloud-home";
const rail: RailState = { places: cloudHome ? [
  { id: "profile:default", name: "This computer", color: null, kind: "computer", profile: "default", opens: true, active: true, paint: { swatch: null }, together: true },
  { id: "home", name: "My Cloud", color: "purple", kind: "cloud", opens: true, paint: { swatch: "violet" }, together: true },
] : [
  { id: "local", name: "This computer", color: null, kind: "computer", opens: true, active: true, paint: { swatch: null }, ...(view === "rail-before" ? {} : { together: joined }) },
  { id: "home", name: "My Cloud", color: "purple", kind: "cloud", opens: true, paint: { swatch: "violet" }, ...(view === "rail-before" ? {} : { together: joined }) },
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

function Gallery() {
  const state: AppState = { ...initialState, bots, selectedId: "ledger", connected: true, config: { ...initialState.config, profile: { name: "Sam", email: "", aboutMe: "" } } as AppState["config"] };
  const value = { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  useEffect(() => {
    if (!view.startsWith("rail-")) return;
    const id = cloudHome ? "profile:default" : "local";
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
