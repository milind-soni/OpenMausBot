// Dev-only: the real Settings window of a self-hosted server, as its admin sees it, served at /licence-preview.html; not in
// the packaged app. Every request is answered here, so it needs no server.
// ?state=connected|pasted|env|kept|grace|graceover|lapsed|over|domains|waiting|never|unlicensed&page=overview|people&skin=midnight|daylight&lang=pt-br
// `never`: a free server install that never had a licence (no card, as before the card existed). `waiting`: connected to
// MausBot, no licence yet. `unlicensed`: a server from before the card, or a desktop.
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const params = new URLSearchParams(location.search);
const page = params.get("page") ?? "overview";
const state = params.get("state") ?? "connected";

const BASE = {
  valid: true, source: "file", customer: "Acme Analytical", plan: "business-server", seats: 20, features: ["budgets", "whitelabel"],
  expiresAt: "2026-12-31", expiresInDays: 34, graceEndsAt: "2027-01-14", graceDaysLeft: null, notice: null, seatsUsed: 14, seatDomains: [] as string[],
  files: true, shown: true, connected: true,
};
const GRACE = { connected: false, expiresAt: "2026-11-23", expiresInDays: -4, graceEndsAt: "2026-12-07", graceDaysLeft: 10 };
const NONE = { valid: false, source: null, customer: null, plan: null, seats: null, features: [], expiresAt: null, expiresInDays: null, graceEndsAt: null, seatsUsed: 3, connected: false };
const LICENCE: Record<string, unknown> = {
  connected: BASE,
  pasted: { ...BASE, connected: false },
  env: { ...BASE, source: "env", connected: false },
  kept: { ...BASE, source: "last-good", connected: false },
  grace: { ...BASE, ...GRACE },
  graceover: { ...BASE, ...GRACE, seatsUsed: 23 },
  lapsed: { ...BASE, valid: false, connected: false, features: [], expiresAt: "2026-10-31", expiresInDays: -27, graceEndsAt: "2026-11-14", graceDaysLeft: 0 },
  over: { ...BASE, seatsUsed: 23 },
  domains: { ...BASE, seatsUsed: 23, seatDomains: ["@acme.example"] },
  waiting: { ...BASE, ...NONE },
  never: { ...BASE, ...NONE, shown: false },
  unlicensed: { error: "not found" },
};
const PEOPLE = ["maya@acme.example", "sam@acme.example", "lee@acme.example", "noor@acme.example", "ravi@acme.example"];

const CONFIG = {
  composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 10 }, localVm: { mode: "shared", maxInstances: 1 },
  profile: { name: "Maya Shah", email: "maya@acme.example" }, features: { savedSteps: false },
  onboarding: { completedAt: "2026-01-01", version: 1, reelSeen: true, hintsSeen: [] },
  edition: { edition: state === "unlicensed" || state === "none" ? "oss" : "enterprise", features: [] }, browserProfiles: [], managedPolicy: null,
  signIn: { admins: [PEOPLE[0]], members: PEOPLE.slice(1) }, membership: { authority: "local", pairingCodes: true },
};
const ANSWERS: Record<string, unknown> = {
  "/api/instances": { instances: [] }, "/api/config": CONFIG,
  "/api/auth/session": { kind: "session", id: "s1", label: "Chrome on Mac", email: PEOPLE[0], scopes: ["admin", "client"], expiresAt: 0 },
  "/api/auth/sessions": { sessions: PEOPLE.map((email, index) => ({ id: `s${index}`, email, lastSeenAt: Date.now() - index * 3_600_000, scopes: index === 0 ? ["admin", "client"] : ["client"] })), current: "s0" },
  "/api/routines": { routines: [], runs: [] }, "/api/webhooks": { webhooks: [], attempts: [] }, "/api/bots": { bots: [], groups: [] },
  "/api/usage": { groups: [] },
  "/api/license": LICENCE[state] ?? BASE,
};
const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.href);
  if (url.origin !== location.origin || !(url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/"))) return realFetch(input, init);
  if (url.pathname === "/.well-known/openmausbot/environment") {
    return Promise.resolve(Response.json({ environmentId: "5d0c6f2e-9c1a-4c57-8f0e-2b7a1d3e4f50", label: "acme", capabilities: { emailSignIn: true } }));
  }
  const status = url.pathname === "/api/license" && state === "unlicensed" ? 404 : 200;
  return Promise.resolve(new Response(JSON.stringify(ANSWERS[url.pathname] ?? {}), { status, headers: { "content-type": "application/json" } }));
};
class QuietEventSource {
  onopen: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 1;
  constructor(readonly url: string) { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "run:0" }) }), 50); }
  addEventListener() {} removeEventListener() {} close() {}
}
Object.assign(window, { EventSource: QuietEventSource });
try {
  localStorage.setItem("omb-advanced-mode", params.get("mode") === "advanced" ? "1" : "0");
} catch { /* blocked storage */ }

const [{ StoreProvider }, { useStoreDispatch, useStoreSelector }, { SettingsModal }, { applySkin, readSkin, SKIN_IDS }, { loadLocale }] = await Promise.all([
  import("@/state/store"), import("@/state/store-select"), import("@/components/SettingsModal"), import("@/lib/skins"), import("@/lib/i18n"),
]);

function SettingsView() {
  const loaded = useStoreSelector((app) => app.config !== null), open = useStoreSelector((app) => app.appSettingsOpen), dispatch = useStoreDispatch();
  useEffect(() => { if (loaded) dispatch({ type: "toggleAppSettings", open: true, section: page as never }); }, [loaded, dispatch]);
  // A phone-width window opens on the list of pages: open the page, as a person would.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      if (document.querySelector("[data-settings-page-body]")) return clearInterval(timer);
      document.querySelector<HTMLElement>(`[data-settings-page="${page}"]`)?.click();
    }, 100);
    return () => clearInterval(timer);
  }, [open]);
  return open ? <SettingsModal /> : null;
}

const asked = params.get("skin");
applySkin((SKIN_IDS as readonly string[]).includes(asked ?? "") ? asked as Parameters<typeof applySkin>[0] : readSkin());
await loadLocale(params.get("lang") ?? "en");
createRoot(document.getElementById("root")!).render(<StrictMode><StoreProvider><SettingsView /></StoreProvider></StrictMode>);
