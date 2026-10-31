import { createRoot } from "react-dom/client";
import type { ChromeRailState } from "../../electron/chrome-rail.mjs";
import type { RailPlace, RailState } from "../../electron/cloud-rail.mjs";
import { CHROME_RAIL_WIDTH } from "../../electron/chrome-rail.mjs";
import App from "../../src/App";
import { ChromeRail } from "../../src/components/ChromeRail";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { BOAT_OFFER_NOTICE, CLOUD_PRO_UPDATE_NOTICE, SIDEBAR_TOUR_NOTICE } from "../../src/lib/notices";
import { markSimpleModePromptSeen } from "../../src/lib/simple-mode-prompt";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

// Served only by scripts/verify-sidebar-tour.ts: the real app as the desktop window shows it, with the window's own rail
// beside it. In the window the rail is this app's page in a view of its own over the page's left edge; here it is the
// same page in a frame there, and the page leaves it the same room (the app's preload does that in the window). The
// page's `rail.mark` reaches the frame as main's `rail:mark` reaches the rail's view. The tour of the rail is due: its
// campaign is unseen, and the Cloud Pro popup and Boat's offer before and after it are seen. ?skin= picks the skin,
// ?mode=simple Simple mode, ?hidden starts with the rail hidden, ?place=computer is this computer's own page (this
// computer and a server connected by hand) instead of My Cloud's. ?part=rail is the rail's own page, in that frame.
const params = new URLSearchParams(location.search);
setAnalyticsEnabled(false);
setEmailGateDone("skipped");
markSimpleModePromptSeen();
setAdvancedMode(params.get("mode") !== "simple");
applySkin((params.get("skin") ?? "midnight") as SkinId);

const place = (id: string, name: string, extra: Partial<RailPlace> = {}): RailPlace => ({ id, name, color: null, kind: "cloud", opens: true, paint: { swatch: null }, ...extra });
const computer = params.get("place") === "computer";
const RAIL: RailState = {
  places: computer
    ? [place("local", "This computer", { kind: "computer", active: true }), place("vps", "Office", { kind: "server" })]
    : [place("home", "My Cloud", { color: "blue", paint: { swatch: "blue" }, active: true }), place("a", "Client A", { color: "teal", paint: { swatch: "green" } }),
      place("acme", "Acme team", { kind: "team", color: "purple", paint: { swatch: "violet" } }), place("mini", "Mac mini", { kind: "server", server: true })],
  add: { cloud: true, link: true, address: computer },
};
const capabilities = async () => ({ host: { platform: "darwin", label: "macOS", session: "unknown", packaged: true }, windowChrome: "mac-inset",
  screenPreview: { available: false, interaction: "none" }, dictation: { available: false, engine: "none", onDevice: false },
  localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" } });
const ok = async () => {};

if (params.get("part") === "rail") {
  // The rail's own page: it lists the places, and hears what the page beside it marks.
  document.documentElement.style.background = document.body.style.background = "transparent";
  let marked: ((part: string | null) => void) | null = null;
  window.addEventListener("message", (event) => { if (event.source === window.parent && event.data && "railMark" in event.data) marked?.(event.data.railMark); });
  Object.assign(window, { ogb: {
    platform: "darwin", app: { version: "0.1.135", ownPage: true }, getCapabilities: capabilities, onCapabilitiesChanged: () => () => {},
    workspaces: { places: async () => RAIL, onChanged: () => () => {}, open: ok, add: ok, recolor: async () => ({ outcome: "saved" }), remove: async () => ({ outcome: "removed" }) },
    rail: { expand: ok, onSkin: () => () => {}, onMark: (heard: (part: string | null) => void) => { marked = heard; return () => { marked = null; }; } },
  } });
  createRoot(document.getElementById("root")!).render(<ChromeRail />);
  // Ready once its places are drawn: the page beside it marks again what it marked meanwhile, as main does on its load.
  const ready = () => (document.querySelector("[data-rail-place]") ? window.parent.postMessage({ railReady: true }, location.origin) : setTimeout(ready, 50));
  ready();
} else {
  // Each view shows the tour from its start: this browser forgets it (the script clears the workspace's record).
  localStorage.removeItem(SIDEBAR_TOUR_NOTICE);
  let hidden = params.has("hidden"), lastMark: string | null = null;
  const heard = new Set<(state: ChromeRailState) => void>();
  const strip = (): ChromeRailState => ({ available: true, hidden });
  const room = document.createElement("style");
  room.textContent = `html { box-sizing: border-box !important; padding-left: ${CHROME_RAIL_WIDTH}px !important; --rail-beside: ${CHROME_RAIL_WIDTH}px; }`;
  const frame = document.createElement("iframe");
  frame.title = "The window's rail";
  frame.src = `${location.pathname}?part=rail&skin=${params.get("skin") ?? "midnight"}${computer ? "&place=computer" : ""}`;
  frame.setAttribute("data-rail-frame", "");
  frame.style.cssText = `position:fixed;left:0;top:0;width:${CHROME_RAIL_WIDTH}px;height:100vh;border:0;background:transparent;color-scheme:normal;z-index:1000`;
  const besidePage = () => {
    if (hidden) { room.remove(); frame.remove(); return; }
    document.head.append(room);
    if (!frame.isConnected) document.body.append(frame);
  };
  Object.assign(window, { ogb: {
    platform: "darwin",
    app: { version: "0.1.135", ownPage: computer },
    getCapabilities: capabilities,
    onCapabilitiesChanged: () => () => {},
    applySkin: ok, setUnreadCount: () => {}, permStatus: async () => ({}),
    workspaces: {
      state: async () => (computer ? { local: true, name: "This computer" } : { local: false, name: "My Cloud", origin: "https://omb-u-1.fly.dev", color: "blue" }),
      menu: ok, line: async () => null, open: ok, add: ok,
      places: async () => ({ places: [], add: { cloud: false, link: false, address: false }, ...(hidden ? {} : { beside: true as const }) }),
      onChanged: () => () => {},
    },
    desktopNotices: { state: async () => ({ seen: [CLOUD_PRO_UPDATE_NOTICE, BOAT_OFFER_NOTICE], cloud: false }), seen: ok, shown: async () => false },
    rail: {
      state: async () => strip(),
      setHidden: async (next: boolean) => { hidden = next; besidePage(); for (const listener of heard) listener(strip()); return strip(); },
      onState: (listener: (state: ChromeRailState) => void) => { heard.add(listener); return () => { heard.delete(listener); }; },
      mark: async (part: string | null) => { lastMark = part; frame.contentWindow?.postMessage({ railMark: part }, location.origin); },
    },
  } });
  // In the window the rail's page is there long before any tour: the app waits for the frame's rail to be drawn.
  const railReady = new Promise<void>((done) => {
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || !event.data?.railReady) return;
      if (lastMark) frame.contentWindow?.postMessage({ railMark: lastMark }, location.origin);
      done();
    });
    setTimeout(done, 20_000);
  });
  besidePage();
  void (hidden ? Promise.resolve() : railReady).then(() => createRoot(document.getElementById("root")!).render(<App />));

  // The macOS window's traffic lights, drawn where the system draws them, over the rail's top as in the window.
  const lights = document.createElement("div");
  lights.setAttribute("aria-hidden", "true");
  lights.style.cssText = "position:fixed;left:12px;top:8px;display:flex;gap:8px;z-index:1001;pointer-events:none";
  for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
    const dot = document.createElement("span");
    dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};display:block`;
    lights.append(dot);
  }
  document.body.append(lights);
}
