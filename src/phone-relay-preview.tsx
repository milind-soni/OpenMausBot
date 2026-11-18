// Dev-only gallery of Remote access with the end-to-end phone connection, served at /phone-relay-preview.html; not in
// the packaged app. It mounts the real settings section and pairing screen over a fake companion bridge.
// ?view=phones|qr&e2e=on|off&relay=connected|off&skin=midnight|daylight&lang=de
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PhoneDevicesSection } from "@/components/PhoneDevicesSection";
import { PhoneSetupFlowView, type CompanionState, type PhoneSetupController } from "@/components/PhoneSetupFlow";
import { phonePairingLink } from "../shared/pairing-link";
import { loadLocale } from "@/lib/i18n";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import { initialState, StoreContext } from "@/state/store";
import "./styles.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "phones";
const e2eOn = params.get("e2e") !== "off";
const relayOn = params.get("relay") !== "off";
const skin = params.get("skin") ?? "midnight";
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");
await loadLocale(params.get("lang") ?? "en");

const now = Date.now();
const K = "BJiFmi3bzpQUayMJErl6eqt24mUOvHEUR6uzutPTHfundIgyZxs3bSzUMydGOfgbWdwQshIyzzlMWqxMkNHnmd0";
const TOKEN = `omb_pair_${"Q".repeat(43)}`;
const device = (id: string, name: string, extra: object) => ({ id, name, createdAt: now - 9e8, lastSeenAt: now - 60_000, cloudDesktopAccess: false, ...extra });
let state: CompanionState = {
  enabled: true,
  keepAwake: false,
  port: 8810,
  devices: [
    device("ipad", "iPad", { lastSeenAt: now - 2 * 86_400_000, e2eAt: now - 5e8, routes: "any", route: null }),
    device("iphone", "Ada's iPhone 16", { e2eAt: now - 5e8, routes: "any", route: e2eOn ? "wifi" : null }),
    device("old", "Old Android", { routes: "any", route: null }),
    device("pixel", "Pixel 9", { e2eAt: now - 5e8, routes: "local", route: e2eOn ? "tailscale" : null }),
  ],
  connectedDeviceIds: ["iphone", "pixel", "old"],
  pairing: view === "qr" ? { code: "482913", token: TOKEN, expiresAt: now + 110_000 } : null,
  addresses: ["192.168.1.20", "100.101.102.103"],
  lan: "192.168.1.20",
  tailscale: "100.101.102.103",
  tailnetName: "ada-mac.tail1234.ts.net",
  discovery: { advertising: true, name: "Ada's MacBook" },
  ...(e2eOn
    ? { e2e: { enabled: true, relay: relayOn ? "connected" : "off", node: relayOn ? "relay1.openmausbot.com" : null, descriptor: relayOn ? { v: 1, k: K, h: "lz81isB3BuNV6rHgYgG3Wg", r: ["relay1.openmausbot.com", "relay2.openmausbot.com"] } : { v: 1, k: K } } }
    : {}),
};
const answer = async (next?: Partial<CompanionState>) => {
  state = { ...state, ...next };
  return state;
};
const bridge = {
  state: () => answer(),
  start: () => answer({ enabled: true }),
  stop: () => answer({ enabled: false }),
  keepAwake: () => answer(),
  refreshTailscale: () => answer(),
  pairing: () => answer(),
  renewPairing: () => answer(),
  cloudDesktop: () => answer(),
  browserControl: () => answer(),
  revoke: (id: string) => answer({ devices: state.devices.filter((each) => each.id !== id) }),
  routes: (id: string, routes: "any" | "local") => answer({ devices: state.devices.map((each) => (each.id === id ? { ...each, routes } : each)) }),
};
const account = { state: async () => ({ available: true, status: "ready", email: "ada@example.com" }) };
(globalThis as unknown as { ogb: unknown }).ogb = { companion: bridge, companionAccount: account };

const link = phonePairingLink({ address: "192.168.1.20", port: 8810, token: TOKEN, code: e2eOn ? undefined : "482913", name: "Ada's MacBook",
  e2e: state.e2e?.descriptor });
const controller = {
  state, account: { available: true, status: "ready", email: "ada@example.com" }, phase: "qr", email: "", code: "", codeSent: false,
  busy: false, accountBusy: false, error: null, accountError: null, pairingLink: link, address: "192.168.1.20",
  pairingPort: 8810, addressText: "192.168.1.20:8810", hostedReady: false, localFallback: true, tailscaleFallback: false,
  tailscaleAvailable: true, pairingExpired: false, setupTimedOut: false, act: async () => {}, accountAct: async () => {},
} as unknown as PhoneSetupController;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreContext.Provider value={{ state: initialState, dispatch: () => {} } as never}>
      <div className="min-h-screen bg-app p-8 text-ink">
        <div className={view === "qr" ? "mx-auto max-w-[520px] rounded-2xl border border-hairline/40 bg-card p-6" : "mx-auto max-w-[640px]"}>
          {view === "qr" ? <PhoneSetupFlowView controller={controller} /> : <PhoneDevicesSection profileEmail="ada@example.com" />}
        </div>
      </div>
    </StoreContext.Provider>
  </StrictMode>,
);
