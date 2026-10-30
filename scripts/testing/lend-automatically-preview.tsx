import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { CLOUD_SETUP_HIDDEN, CLOUD_WELCOME_DONE } from "../../src/lib/cloud-setup";
import { withTourFinished } from "../../src/lib/guided-tour";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import { markSimpleModePromptSeen } from "../../src/lib/simple-mode-prompt";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

// Served only by scripts/verify-lend-automatically.ts: the real app's Settings → MausBot Cloud, against the disposable
// fake-engine server. ?page=local is this computer's own page, its desktop bridge's verified Cloud sign-in answered
// here (a Pro plan, My Cloud ready); ?page=cloud is My Cloud's own page in the desktop window, the fixture server's
// config read as a Cloud home's. ?skin= picks the skin.
const params = new URLSearchParams(location.search);
const page = params.get("page") === "local" ? "local" : "cloud";
setAnalyticsEnabled(false);
setEmailGateDone("skipped");
markSimpleModePromptSeen();
setAdvancedMode(true);
applySkin((params.get("skin") ?? "midnight") as SkinId);

const ORIGIN = "https://omb-u-fixture.fly.dev";
const account = {
  status: "connected", account: { id: "acct_fixture", email: "you@example.test" }, deviceId: "device-fixture",
  entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: Date.now() + 30 * 86_400_000, version: 3 },
  machine: { status: "ready", origin: ORIGIN },
};
const ok = async () => {};
const signedIn = async () => account;
const cloudAccount = {
  state: signedIn, onState: () => () => {}, begin: signedIn, signInAgain: signedIn, reopen: signedIn, cancel: signedIn, refresh: signedIn,
  signOut: signedIn, openDashboard: signedIn, offer: async () => null, connectHome: signedIn, connectHomeForPhone: signedIn,
};
let openSettings: ((section?: string) => void) | null = null;
Object.assign(window, { ogb: {
  platform: "darwin",
  app: { version: "0.1.130", ownPage: page === "local" },
  getCapabilities: async () => ({ host: { platform: "darwin", label: "macOS", session: "unknown", packaged: true }, windowChrome: "mac-inset",
    screenPreview: { available: false, interaction: "none" }, dictation: { available: false, engine: "none", onDevice: false },
    localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" } }),
  onCapabilitiesChanged: () => () => {},
  onOpenAppSettings: (callback: (section?: string) => void) => { openSettings = callback; return () => {}; },
  applySkin: ok, setUnreadCount: () => {}, permStatus: async () => ({}),
  workspaces: {
    state: async () => (page === "local" ? { local: true, name: "This computer", origin: "" } : { local: false, name: "My Cloud", origin: ORIGIN, color: "blue" }),
    menu: ok, line: async () => null, places: async () => ({ places: [], add: { cloud: false, link: false, address: false } }), open: ok, add: ok, onChanged: () => () => {},
    look: async () => ({ name: "My Cloud", color: "blue", swatch: "blue", change: "admin" }),
  },
  ...(page === "local"
    ? { remoteClient: { active: false }, cloudAccount }
    : { cloudPlan: { state: async () => ({ status: "paid", tier: "pro", home: true }), manage: ok } }),
} });

// My Cloud's own page: the fixture server answers as a Cloud home whose welcome and setup card are behind it.
if (page === "cloud") {
  const fetchFromServer = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchFromServer(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname !== "/api/config" || (init?.method ?? "GET") !== "GET" || !response.ok) return response;
    const config = await response.json();
    const onboarding = { ...config.onboarding, completedAt: config.onboarding?.completedAt ?? new Date().toISOString() };
    return Response.json({ ...config, cloudHome: true, onboarding: { ...onboarding, hintsSeen: [...withTourFinished(onboarding), CLOUD_SETUP_HIDDEN, CLOUD_WELCOME_DONE] } });
  };
}

createRoot(document.getElementById("root")!).render(<App />);

const opened = () => new Promise<void>((resolve) => {
  const tick = () => { if (openSettings) { openSettings("cloud-settings"); resolve(); } else setTimeout(tick, 100); };
  tick();
});
void opened();
