// Dev-only gallery of "Let <server>'s bots use this computer", served at /lend-preview.html; not in the packaged app. It
// mounts the real switch, the real Settings window and the real add form over a fake desktop bridge (no main process,
// no server), so each state can be looked at and photographed.
// ?view=panel&state=off|on|connecting|permissions|shared|team|old|browser  (the Screen panel's part, on a server's page)
// ?view=settings&section=app|devices&state=off|on&add=1&select=<device id>  (This computer's own Settings)
// &skin=midnight|daylight&advanced=1
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Monitor } from "lucide-react";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { LendHere } from "@/components/LendComputerSwitch";
import { SettingsModal } from "@/components/SettingsModal";
import { productName } from "@/lib/brand";
import { loadLocale, t } from "@/lib/i18n";
import { setAdvancedMode } from "@/lib/interface-mode";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import { initialState, StoreContext } from "@/state/store";
import "./styles.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") === "settings" ? "settings" : "panel";
const stateName = params.get("state") ?? "off";
const skin = params.get("skin") ?? "midnight";
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");
setAdvancedMode(params.get("advanced") === "1");
await loadLocale(params.get("lang") ?? "en");

const name = "Hetzner box";
const views: Record<string, DesktopLendView> = {
  off: { name, lendable: true, on: false, connected: false, paused: false },
  on: { name, lendable: true, on: true, connected: true, paused: false },
  connecting: { name, lendable: true, on: true, connected: false, paused: false },
  permissions: { name, lendable: true, on: true, connected: true, paused: false, screen: "permissions" },
  shared: { name: "Office server", lendable: false, why: "shared" },
  team: { name: "Acme team", lendable: false, why: "team" },
  old: { name, lendable: false, why: "old" },
};
let lent = views[stateName] ?? views.off!;
const lendComputer = {
  state: async () => lent,
  set: async (_id: string | null, on: boolean) => { lent = { ...(lent as Extract<DesktopLendView, { lendable: true }>), on, connected: on }; return lent; },
  allowScreen: async () => { lent = { ...(lent as Extract<DesktopLendView, { lendable: true }>), screen: undefined }; return lent; },
  ...(view === "settings" ? { wish: async () => true } : {}),
};
const browser = stateName === "browser";
const now = Date.now();
const environments = [
  { id: "local", kind: "local" as const, name: "This computer" },
  { id: "vps", kind: "remote" as const, name, origin: "https://maus.example.com" },
];
const capabilities = {
  host: { platform: "darwin", label: "macOS", session: "", packaged: true, homeDir: "" },
  windowChrome: "native", windowFrame: true,
  screenPreview: { available: false, interaction: "none", reasonCode: "remote-server" },
  dictation: { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" },
  localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable", reasonCode: view === "panel" ? "remote-server" : undefined },
};
const ogb = browser ? undefined : {
  platform: "darwin",
  app: { version: "0.1.178", ownPage: view === "settings" },
  getCapabilities: async () => capabilities,
  onCapabilitiesChanged: () => () => {},
  lendComputer,
  ...(view === "settings" ? {
    environments: { state: async () => ({ localOrigin: "http://127.0.0.1:8799", remote: false, packaged: true, activeId: "local", environments }),
      status: async () => [{ id: "vps", state: "connected", since: now - 9e8, version: "0.1.178", behind: false, install: "docker" }],
      switch: async () => {}, forget: async () => {}, retry: async () => {}, addFromLink: async () => {}, create: async () => ({ ok: true, state: null }), pickDir: async () => ({ ok: false }) },
    computerSharing: { servers: async () => [{ id: "vps", enabled: lent.lendable && lent.on, connected: true, paused: false }] },
    workspaces: { state: () => new Promise(() => {}), places: () => new Promise(() => {}), add: async () => {},
      probe: async () => ({ outcome: "found", origin: "https://maus.example.com", label: "maus.example.com", version: "0.1.178", transport: "https" }) },
  } : {}),
};
(globalThis as unknown as { ogb: unknown }).ogb = ogb;

const config = { profile: { name: "Ada", email: "ada@example.com" }, membership: { authority: "local", pairingCodes: true }, managedPolicy: null, vps: { configured: false, servers: [] } };
globalThis.fetch = async (input: RequestInfo | URL) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
  if (path === "/api/config") return Response.json(config);
  if (path === "/api/auth/session") return Response.json({ kind: "loopback", trust: "owner" });
  if (path === "/api/auth/sessions") return Response.json({ sessions: [], current: null });
  if (path === "/api/phones") return Response.json({ phones: [] });
  return Response.json({ error: "not in the preview" }, { status: 404 });
};

/** The Screen panel's computer tab around the switch, as on a server's own page: a stand-in frame with the panel's own
 * words, not the real panel (ComputerPanel.simple.test.ts checks the real one carries LendHere). */
function PanelFrame() {
  const [bot] = useState("Ada");
  return <div className="flex min-h-screen justify-end bg-app">
    <aside className="flex w-[380px] flex-col border-l border-hairline/40 bg-panel px-5 pb-5">
      <div className="mb-1.5 mt-4 text-[13px] text-ink-secondary">{`${bot}’s screen`}</div>
      <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
        <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary"><Monitor size={22} /><span className="text-[12px]">{browser ? t("computer.problem.localNeedsApp", { app: productName() }) : t("computer.problem.lendRemoteServer")}</span></div>
      </div>
      {/* As for a bot set to This computer, the panel's own line over the screen; the switch or reason under it. */}
      <div data-preview-ready><LendHere appNeeded={browser || stateName === "team"} /></div>
    </aside>
  </div>;
}

const state = { ...initialState, config: config as never, appSettingsOpen: true, appSettingsSection: (params.get("section") === "devices" ? "devices" : "app") as never };
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DesktopCapabilitiesProvider>
      {view === "panel" ? <PanelFrame /> : <StoreContext.Provider value={{ state, dispatch: () => {} } as never}>
        <div className="min-h-screen bg-app" />
        <SettingsModal />
      </StoreContext.Provider>}
    </DesktopCapabilitiesProvider>
  </StrictMode>,
);

const after = (ms: number, run: () => void) => window.setTimeout(run, ms);
if (params.get("add") === "1") after(900, () => {
  document.querySelector<HTMLElement>("[data-server-connect]")?.click();
  after(300, () => {
    const input = document.querySelector<HTMLInputElement>("[data-own-server-link]");
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://maus.example.com#code=7KQ2-M9XD-H4TP");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    after(200, () => { if (params.get("wish") === "1") document.querySelector<HTMLElement>("[data-lend-add] [role=switch]")?.click(); });
  });
});
const select = params.get("select");
if (select) after(900, () => document.querySelector<HTMLElement>(`[data-device-node="${select}"]`)?.click());
// The switch sits low on This app's page: bring it into view for a picture.
if (view === "settings") after(params.get("add") === "1" ? 1600 : 1000, () => document.querySelector("[data-lend-add], [data-lend-switch], [data-device-node]")?.scrollIntoView({ block: "center" }));
