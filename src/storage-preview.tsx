// Dev-only: the real Settings window and the real sidebar foot against a Cloud home's answers, served at
// /storage-preview.html; not in the packaged app. Every request is answered here, so it needs no server.
// ?view=settings|sidebar&page=storage|overview&state=none|first|normal|near|full&skin=midnight|daylight&lang=de&team=1
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const GB = 1024 ** 3;
const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "settings";
const page = params.get("page") ?? "storage";
const state = params.get("state") ?? "normal";
const USED: Record<string, number> = { first: 41, normal: 50, near: 84, full: 93 };
const used = USED[state] ?? 50;
/** A Team Cloud's admin: "bot-x7" is a teammate's own MausBot, which the app never lists for anyone else. */
const team = params.get("team") === "1";

const report = state === "first"
  ? { at: null, ageS: null, tookS: null, running: true, progress: { entries: 21_000, waitedS: 0 }, volume: null, walkedBytes: null, unwalkedBytes: null,
    categories: [], bots: [], botsRest: { bytes: 0, files: 0, count: 0 }, botsGone: { bytes: 0, files: 0, count: 0 }, other: null, skipped: null,
    linksCapped: false, linksUncheckedBytes: 0, resumes: 0, failed: false }
  : { at: Date.now() - 2 * 3_600_000, ageS: 2 * 3_600, tookS: 540, running: false, progress: null,
    volume: { totalBytes: 100 * GB, freeBytes: (100 - used) * GB, usedBytes: used * GB }, walkedBytes: (used - 1.6) * GB, unwalkedBytes: 1.6 * GB,
    categories: [
      { name: "bot_files", class: "work", bytes: used * 0.38 * GB, files: 41_000 },
      { name: "packages", class: "rebuildable", bytes: used * 0.22 * GB, files: 380_000 },
      { name: "conversations", class: "precious", bytes: used * 0.14 * GB, files: 2_400 },
      { name: "browser_cache", class: "rebuildable", bytes: used * 0.07 * GB, files: 9_000 },
      { name: "attachments", class: "work", bytes: used * 0.06 * GB, files: 1_200 },
      { name: "engine_state", class: "precious", bytes: used * 0.04 * GB, files: 800 },
      { name: "other", class: "work", bytes: (used * 0.09 - 1.6) * GB, files: 300 },
    ],
    bots: [{ id: "chief", bytes: used * 0.19 * GB, files: 20_000 }, { id: "research", bytes: used * 0.11 * GB, files: 9_000 },
      { id: "bot-x7", bytes: used * 0.04 * GB, files: 2_000 }, { id: "inbox", bytes: used * 0.02 * GB, files: 900 }],
    botsRest: { bytes: used * 0.03 * GB, files: 1_000, count: 2 }, botsGone: { bytes: used * 0.025 * GB, files: 800, count: 1 }, other: null, skipped: null,
    linksCapped: false, linksUncheckedBytes: 0, resumes: 0, failed: false };
const storage = state === "none" ? { storage: null } : { storage: report, now: { totalBytes: 100 * GB, freeBytes: (100 - used) * GB, usedBytes: used * GB }, measureInS: 0,
  server: "5d0c6f2e-9c1a-4c57-8f0e-2b7a1d3e4f50" };

const CONFIG = {
  composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 10 }, localVm: { mode: "shared", maxInstances: 1 },
  profile: { name: "Maya Shah", email: "maya@example.com" }, features: { savedSteps: false },
  onboarding: { completedAt: "2026-01-01", version: 1, reelSeen: true, hintsSeen: [] },
  edition: { edition: "community", features: [] }, browserProfiles: [], managedPolicy: null,
  signIn: { admins: [], members: [] }, membership: { authority: "local", pairingCodes: true }, cloudHome: true,
  ...(team ? { team: { id: "team-1", name: "Studio" } } : {}),
};
const ANSWERS: Record<string, unknown> = {
  "/api/instances": { instances: [] }, "/api/config": CONFIG,
  "/api/auth/session": { kind: "session", id: "s1", label: "Chrome on Mac", email: "maya@example.com", scopes: ["admin", "client"], expiresAt: 0 },
  "/api/auth/sessions": { sessions: [{ id: "s1" }], current: "s1" }, "/api/routines": { routines: [], runs: [] }, "/api/webhooks": { webhooks: [], attempts: [] },
  "/api/bots": { bots: [{ id: "chief", name: "Chief", threadId: "t-chief" }, { id: "research", name: "Research", threadId: "t-research" }, { id: "inbox", name: "Inbox", threadId: "t-inbox" }], groups: [] },
  "/api/diagnostics/storage": storage,
};
const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
  return Promise.resolve(new Response(JSON.stringify(ANSWERS[url.pathname] ?? {}), { headers: { "content-type": "application/json" } }));
};
class QuietEventSource {
  onopen: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 1;
  constructor(readonly url: string) { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "run:0" }) }), 50); }
  addEventListener() {} removeEventListener() {} close() {}
}
Object.assign(window, { EventSource: QuietEventSource });
try {
  for (const key of Object.keys(localStorage)) if (key.startsWith("openmausbot.storageNotice.seen.v1")) localStorage.removeItem(key);
  // Simple mode, the default for a new install, unless ?mode=advanced.
  localStorage.setItem("omb-advanced-mode", params.get("mode") === "advanced" ? "1" : "0");
} catch { /* blocked storage */ }

const [{ StoreProvider }, { useStoreDispatch, useStoreSelector }, { SettingsModal }, { SidebarFooter }, { applySkin, readSkin, SKIN_IDS }, { loadLocale }] = await Promise.all([
  import("@/state/store"), import("@/state/store-select"), import("@/components/SettingsModal"), import("@/components/SidebarFooter"), import("@/lib/skins"), import("@/lib/i18n"),
]);

function SettingsView() {
  const loaded = useStoreSelector((app) => app.config !== null), open = useStoreSelector((app) => app.appSettingsOpen), dispatch = useStoreDispatch();
  useEffect(() => { if (loaded) dispatch({ type: "toggleAppSettings", open: true, section: page as never }); }, [loaded, dispatch]);
  return open ? <SettingsModal /> : null;
}

function SidebarView() {
  return <div className="flex h-screen bg-app text-ink">
    <aside className="flex w-[280px] shrink-0 flex-col justify-end border-e border-hairline/40 bg-panel">
      <SidebarFooter density="comfortable" simple toolsCollapsed={false} />
    </aside>
    <main className="flex-1" />
  </div>;
}

const asked = params.get("skin");
applySkin((SKIN_IDS as readonly string[]).includes(asked ?? "") ? asked as Parameters<typeof applySkin>[0] : readSkin());
await loadLocale(params.get("lang") ?? "en");
createRoot(document.getElementById("root")!).render(<StrictMode><StoreProvider>{view === "sidebar" ? <SidebarView /> : <SettingsView />}</StoreProvider></StrictMode>);
