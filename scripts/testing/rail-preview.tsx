import { createRoot } from "react-dom/client";
import type { CloudSwatch } from "../../electron/cloud-list.mjs";
import type { AddCloudView, RailPlace, RailState } from "../../electron/cloud-rail.mjs";
import type { PlaceLook } from "../../electron/place-look.mjs";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { setSidebarDensity } from "../../src/lib/sidebar-preferences";
import { markSimpleModePromptSeen } from "../../src/lib/simple-mode-prompt";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

// Served only by scripts/verify-cloud-rail.ts: the real app, as a Cloud's page in the desktop window sees it, with the
// desktop bridge a hosted Cloud's page gets (its rail and add-a-Cloud sheet answered here). ?skin= picks the skin,
// ?mode=simple Simple mode, ?sheet=add|server|cloud|name|connect opens ＋'s sheet there (?adding=setting_up: a Cloud
// being bought; connect: a signed-in server's), ?places=many the list past eight (?more opens it), ?places=servers the
// person's own servers that signed in. ?look=<colour>|none is the place's colour (its tint), ?member a team's Cloud
// its member is on, ?settings=look Settings → Appearance at the place's colour, ?menu=<id> that circle's own menu (a
// right-click: its colour). ?place=computer is this computer's own page instead, on a desktop with no Cloud: no rail,
// or with ?rail one beside it (this computer and a server connected by hand). ?density=icons collapses the sidebar to
// avatars; ?settings=general opens Settings at its first page, ?settings=strip at the switch for the window's rail.
// ?hidden starts with the rail hidden (the sidebar's button shows it again). The rail is drawn on the page itself, as an
// older app's page draws it; ?chrome stands in for the window's own rail instead: the room the app's preload leaves
// for it, with nothing drawn there, so the page lays out as it does beside the real one.
const params = new URLSearchParams(location.search);
setAnalyticsEnabled(false);
setEmailGateDone("skipped");
markSimpleModePromptSeen();
setAdvancedMode(params.get("mode") !== "simple");
setSidebarDensity(params.get("density") === "icons" ? "icons" : "comfortable");
applySkin((params.get("skin") ?? "midnight") as SkinId);

const place = (id: string, name: string, extra: Partial<RailPlace> = {}): RailPlace => ({ id, name, color: null, kind: "cloud", opens: true, ...extra });
const FEW: RailPlace[] = [
  place("home", "My Cloud", { color: "blue", active: true }),
  place("a", "Client A", { color: "teal" }),
  place("b", "Bakery", { color: "orange", attention: true }),
  place("acme", "Acme team", { kind: "team", color: "purple" }),
  place("pending:c", "Client C", { color: "red", opens: false, progress: 0.55 }),
  place("mini", "Mac mini", { kind: "server" }),
];
const SERVERS: RailPlace[] = [
  place("home", "My Cloud", { color: "blue", active: true }),
  place("a", "Client A", { color: "teal" }),
  place("acme", "Acme team", { kind: "team", color: "purple" }),
  place("vps", "Office", { kind: "server", server: true }),
  place("signed-in:s-mini", "Mac mini", { kind: "server", opens: false, ownNetwork: true, server: true, offline: true, lastSeenAt: Date.now() - 2 * 3_600_000 }),
  place("signed-in:s-render", "Render VPS", { kind: "server", color: "red", opens: false, pairs: true, server: true }),
];
const MANY = [...FEW, ...["Delta", "Echo Studio", "Fable", "Gamma Ltd", "Harbor"].map((name, n) => place(`x${n}`, name, { color: (["teal", "yellow", "red", "purple", "blue"] as const)[n] }))];
const member = params.has("member");
const computer = params.get("place") === "computer";
const COMPUTER: RailPlace[] = [place("local", "This computer", { kind: "computer" }), place("vps", "Office", { kind: "server" })];
const SWATCH: Record<string, CloudSwatch> = { blue: "blue", teal: "green", yellow: "amber", red: "rose", purple: "violet" };
const COLOR: Record<CloudSwatch, PlaceLook["color"]> = { blue: "blue", green: "teal", amber: "yellow", rose: "red", violet: "purple", slate: null };
const tint = params.get("look") ?? (computer ? "none" : member ? "purple" : "blue");
const color = tint === "none" ? null : (tint as PlaceLook["color"]);
const listed = computer ? (params.has("rail") ? COMPUTER : []) : params.get("places") === "many" ? MANY : params.get("places") === "servers" ? SERVERS : FEW;
const onScreen = computer ? "local" : member ? "acme" : "home";
// The place on screen wears the colour its tint is drawn in.
// Every place but one still being made has its colour changed from its circle; a team's member only sees it.
const painted = (entry: RailPlace): RailPlace => (entry.opens || entry.server ? { ...entry, paint: { swatch: entry.color ? SWATCH[entry.color] ?? null : null,
  ...(member && entry.id === "acme" ? { locked: "member" as const } : {}) } } : entry);
const rail: RailState = { places: listed.map(({ active: _active, ...entry }) => painted(entry.id === onScreen ? { ...entry, color, active: true as const } : entry)),
  add: { cloud: true, link: true, address: computer } };
let look: PlaceLook = { name: computer ? "This computer" : member ? "Acme team" : "My Cloud", color, swatch: color ? SWATCH[color] ?? null : null,
  change: computer ? "local" : member ? null : "admin", ...(member ? { reason: "member" as const } : {}) };
let openSettings: ((section?: string) => void) | null = null;
const offer = { recommended: "pro", refundDays: 14, plans: [
  { tier: "starter", label: "Starter", amount: 1500, allowances: { cpus: 2, cpuKind: "shared" as const, memoryMb: 2048, diskGb: 10, maxDiskGb: 20, computers: 15, computerHours: 100, voiceCharacters: 30_000, sleeps: true as const } },
  { tier: "pro", label: "Pro", amount: 4900, allowances: { cpus: 4, cpuKind: "shared" as const, memoryMb: 4096, diskGb: 10, maxDiskGb: 100, computers: 15, computerHours: 300, voiceCharacters: 60_000 } },
  { tier: "max", label: "Max", amount: 9900, allowances: { cpus: 8, cpuKind: "shared" as const, memoryMb: 8192, diskGb: 10, maxDiskGb: 100, computers: 15, computerHours: 800, voiceCharacters: 180_000 } },
] };
const adding = params.get("adding") === "setting_up"
  ? { adding: { name: "Client C", color: "rose" as const, tier: "pro", startedAt: Date.now(), status: "setting_up" as const, progress: 0.55, link: true as const } } : {};
const addView: AddCloudView = { signedIn: true, hasCloud: true, supported: true, canAdd: true, offer, count: 3, home: { name: "My Cloud", color: "blue" }, ...adding };
const ok = async () => {};
const chrome = params.has("chrome");
let hidden = params.has("hidden");
const placesHeard = new Set<() => void>(), stripHeard = new Set<(state: { available: boolean; hidden: boolean }) => void>();
const strip = () => ({ available: listed.length > 1, hidden });
const room = document.createElement("style");
room.textContent = "html { box-sizing: border-box !important; padding-left: 64px !important; --rail-beside: 64px; }";
const besidePage = () => { if (chrome && !hidden) document.head.append(room); else room.remove(); };
besidePage();
Object.assign(window, { ogb: {
  platform: "darwin",
  app: { version: "0.1.130", ownPage: computer },
  getCapabilities: async () => ({ host: { platform: "darwin", label: "macOS", session: "unknown", packaged: true }, windowChrome: "mac-inset",
    screenPreview: { available: false, interaction: "none" }, dictation: { available: false, engine: "none", onDevice: false },
    localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" } }),
  onCapabilitiesChanged: () => () => {},
  onOpenAppSettings: (callback: (section?: string) => void) => { openSettings = callback; return () => {}; },
  applySkin: ok, setUnreadCount: () => {}, permStatus: async () => ({}),
  workspaces: {
    state: async () => (computer ? { local: true, name: "This computer" } : { local: false, name: "My Cloud", origin: "https://omb-u-1.fly.dev", color: "blue" }),
    menu: ok, line: async () => null, open: ok, add: ok,
    places: async () => (hidden ? { ...rail, places: [] } : chrome ? { ...rail, places: [], beside: true as const } : rail),
    onChanged: (heard: () => void) => { placesHeard.add(heard); return () => { placesHeard.delete(heard); }; },
    look: async () => look,
    recolor: async (id: string, swatch: CloudSwatch) => {
      rail.places = rail.places.map((entry) => (entry.id === id ? { ...entry, color: COLOR[swatch], paint: { swatch: COLOR[swatch] ? swatch : null } } : entry));
      return { outcome: "saved", look: null };
    },
    color: async (swatch: CloudSwatch) => { look = { ...look, swatch: COLOR[swatch] ? swatch : null, color: COLOR[swatch] }; return { outcome: "saved", look }; },
  },
  cloudAdd: { state: async () => addView, start: async () => ({ outcome: "opened" }), reopen: async () => true, copyLink: async () => true, open: ok, interest: ok, sheet: ok },
  rail: {
    state: async () => strip(),
    setHidden: async (next: boolean) => {
      hidden = next;
      besidePage();
      for (const heard of placesHeard) heard();
      for (const heard of stripHeard) heard(strip());
      return strip();
    },
    onState: (heard: (state: { available: boolean; hidden: boolean }) => void) => { stripHeard.add(heard); return () => { stripHeard.delete(heard); }; },
  },
} });

if (member) {
  // The fixture server takes this browser for its owner; a team's member is signed in without the admin scope.
  const fixtureFetch = window.fetch.bind(window);
  window.fetch = (input, init) => (new URL(input instanceof Request ? input.url : String(input), location.href).pathname === "/api/auth/session"
    ? Promise.resolve(Response.json({ kind: "session", id: "member", label: "Bob's Mac", scopes: ["client"], expiresAt: Date.now() + 3_600_000 }))
    : fixtureFetch(input, init));
}

createRoot(document.getElementById("root")!).render(<App />);

// The macOS window's traffic lights, drawn where the system draws them, so the picture shows what sits beside them.
const lights = document.createElement("div");
lights.setAttribute("aria-hidden", "true");
lights.style.cssText = "position:fixed;left:16px;top:17px;display:flex;gap:8px;z-index:100;pointer-events:none";
for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
  const dot = document.createElement("span");
  dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};display:block`;
  lights.append(dot);
}
document.body.append(lights);

const click = (selector: string) => new Promise<void>((resolve) => {
  const tick = () => { const target = document.querySelector<HTMLElement>(selector); if (target) { target.click(); resolve(); } else setTimeout(tick, 100); };
  tick();
});
const sheet = params.get("sheet");
if (sheet === "connect") void click('[data-rail-place="signed-in:s-render"]');
else if (sheet) void click("[data-rail-add]").then(() => (sheet === "server" ? click('[data-place-add-choice="server"]') : sheet === "add" ? undefined : click('[data-place-add-choice="cloud"]')))
  .then(() => (sheet === "name" ? click("[data-plan-buy='pro']") : undefined));
const openedSettings = () => new Promise<void>((resolve) => { const tick = () => { if (openSettings) { openSettings(); resolve(); } else setTimeout(tick, 100); }; tick(); });
const settings = params.get("settings");
if (settings) {
  // Simple mode's General page has the sidebar's rows and the rail's switch; Advanced keeps them in Appearance.
  void openedSettings().then(() => (params.get("mode") === "simple" || settings === "general" ? undefined : click('[data-settings-section="appearance"]')))
    .then(() => new Promise<void>((resolve) => setTimeout(resolve, 300)))
    .then(() => {
      if (settings === "general") return document.querySelector("[data-settings-block='appearance']")?.scrollIntoView({ block: "start" });
      // The rail's switch closes the picture, with the sidebar's own rows above it.
      if (settings === "strip") return document.querySelector("[data-rail-switch]")?.scrollIntoView({ block: "end" });
      const shown = document.querySelector("[data-place-look], [data-place-picture]");
      (shown?.closest("[data-sidebar-look]") ?? shown)?.scrollIntoView({ block: "center" });
    });
}
if (params.has("more")) void click("[data-rail-more-button]");
const menu = params.get("menu");
if (menu) {
  const opened = () => { const circle = document.querySelector(`[data-rail-place="${menu}"]`); if (circle) circle.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); else setTimeout(opened, 100); };
  opened();
}
