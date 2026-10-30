// Dev-only gallery of bringing the bots together on a server of the person's own, served at /one-home-preview.html; not in
// the packaged app. It mounts the real rail and account line over fake bridges, with no server behind them.
// ?state=menu|moving|failing&skin=midnight|daylight&lang=de
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { CloudSendNotice } from "../electron/cloud-send.mjs";
import type { RailState } from "../electron/cloud-rail.mjs";
import { PlacesRail } from "@/components/PlacesRail";
import { SidebarFooter } from "@/components/SidebarFooter";
import { setLocale } from "@/lib/i18n";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import { initialState, StoreContext, type AppState } from "@/state/store";
import "./styles.css";

const params = new URLSearchParams(location.search);
const stateName = params.get("state") ?? "menu";
const skin = params.get("skin") ?? "midnight";
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");
setLocale(params.get("lang") ?? "en");

const rail: RailState = { places: [
  { id: "local", name: "This computer", color: null, kind: "computer", opens: true, active: true, paint: { swatch: null } },
  { id: "garage", name: "Garage server", color: "teal", kind: "server", opens: true, makeHome: true, paint: { swatch: "green" } },
], add: { cloud: true, link: true, address: false } };
const move = stateName === "failing"
  ? { phase: "copy" as const, place: "Garage server", failing: { error: "This app isn't signed in to Garage server. Open Garage server in this app, then try again." } }
  : stateName === "moving" ? { phase: "copy" as const, place: "Garage server", chats: { done: 14, total: 31 } } : null;
const notice = { ready: true, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false, running: false, last: null, whole: null,
  arrived: { bots: 0, updatedBots: 0, skills: 0, logins: 0, settings: 0, onePassword: false, chats: { conversations: 0, messages: 0 } }, ...(move ? { move } : {}) } as unknown as CloudSendNotice;
Object.assign(window, { ogb: {
  workspaces: { places: async () => rail, state: async () => ({ local: true, name: "This computer" }), menu: async () => {}, open: async () => {}, add: async () => {},
    makeHome: async () => ({ started: true }), onChanged: () => () => {} },
  rail: { expand: async () => {}, onSkin: () => () => {} },
  cloudSendPage: { notice: async () => notice, dismiss: async () => notice, moveRetry: async () => notice, onNotice: () => () => {} },
} });

function Gallery() {
  const state: AppState = { ...initialState, connected: true, config: { ...initialState.config, profile: { name: "Sam", email: "", aboutMe: "" } } as AppState["config"] };
  const value = { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  useEffect(() => {
    if (stateName !== "menu") return;
    const timer = setInterval(() => {
      const circle = document.querySelector('[data-rail-place="garage"]');
      if (!circle || document.querySelector("[data-rail-menu]")) return;
      circle.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    }, 100);
    return () => clearInterval(timer);
  }, []);
  return (
    <StoreContext.Provider value={value}>
      <div className="flex h-screen bg-panel text-ink">
        <div className="relative flex w-[60px] shrink-0 flex-col items-center border-e border-hairline/60 pt-3"><PlacesRail chrome /></div>
        <div className="flex w-[280px] shrink-0 flex-col justify-end border-e border-hairline/60 bg-sidebar">
          <SidebarFooter density="comfortable" simple toolsCollapsed={false} />
        </div>
        <div className="flex-1 bg-canvas" />
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
