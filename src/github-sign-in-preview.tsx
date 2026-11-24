// Dev-only: the GitHub sign-in in the real Apps panel, a Team Cloud member's Apps page and a chat's card, against made-up
// answers, served at /github-sign-in-preview.html; not in the packaged app. Every request is answered here.
// ?view=apps|member|chat&gh=out|download|expired|installing|code|mausbot|cli|token|invalid|refused|token-error|hidden
//  &composio=connected|open&q=git&skin=midnight|daylight&lang=de
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { GithubSignInStatus } from "../shared/github-sign-in";
import "./styles.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "apps";
const gh = params.get("gh") ?? "out";
const composioGithub = params.get("composio") ?? "open";
const AT = Date.UTC(2026, 10, 24, 9, 0);

const STATUS: Record<string, GithubSignInStatus> = {
  out: { state: "signed-out", download: false },
  download: { state: "signed-out", download: true },
  expired: { state: "signed-out", download: false, last: { outcome: "expired", at: AT } },
  installing: { state: "installing" },
  code: { state: "signing-in", code: "WDJB-MJHT", verificationUrl: "https://github.com/login/device", expiresAt: Date.now() + 15 * 60_000 },
  mausbot: { state: "signed-in", login: "maya-shah", source: "mausbot", scopes: ["repo", "read:org", "gist"], orgs: ["acme-labs", "maya-oss"], checkedAt: AT },
  cli: { state: "signed-in", login: "maya-shah", source: "cli", scopes: ["repo"], checkedAt: AT },
  token: { state: "signed-in", login: "maya-shah", source: "token", scopes: [], checkedAt: AT },
  invalid: { state: "invalid", login: "maya-shah", source: "mausbot", reason: "GitHub refused the saved sign-in." },
  refused: { state: "signed-out", download: false },
  "token-error": { state: "signed-out", download: false },
};
const github = STATUS[gh] ?? STATUS.out!;

const card = (slug: string, label: string, blurb: string, categories: string[]) => ({ slug, label, blurb, logo: null, domain: null, categories });
const CARDS = [
  card("github", "GitHub", "Manage repositories, issues and pull requests", ["Developer tools"]),
  card("gmail", "Gmail", "Read, send and organize email", ["Communication"]),
  card("slack", "Slack", "Send messages and read channels", ["Communication"]),
  card("notion", "Notion", "Pages, notes and databases", ["Productivity"]),
  card("linear", "Linear", "Issues, projects and cycles", ["Developer tools"]),
  card("googlecalendar", "Google Calendar", "Events and schedules", ["Productivity"]),
  card("sentry", "Sentry", "Errors and performance issues", ["Developer tools"]),
  card("jira", "Jira", "Issues and boards", ["Developer tools"]),
];
const services: Record<string, unknown> = { gmail: { connected: true, status: "ACTIVE", accounts: [{ id: "ca_gmail", status: "ACTIVE" }] } };
if (composioGithub === "connected") services.github = { connected: true, status: "ACTIVE", accounts: [{ id: "ca_github", status: "ACTIVE" }] };

const CONFIG = {
  composio: { configured: true }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 10 }, localVm: { mode: "shared", maxInstances: 1 },
  profile: { name: "Maya Shah", email: "maya@example.com" }, features: { savedSteps: false },
  onboarding: { completedAt: "2026-01-01", version: 1, reelSeen: true, hintsSeen: [] },
  edition: { edition: "community", features: [] }, browserProfiles: [], managedPolicy: null,
  signIn: { admins: [], members: [] }, membership: { authority: "local", pairingCodes: true }, cloudHome: false,
  ...(view === "member" ? { team: { id: "t1", name: "Acme Labs" } } : {}),
};
const ANSWERS: Record<string, unknown> = {
  "/api/instances": { instances: [] }, "/api/config": CONFIG,
  "/api/auth/session": { kind: "session", id: "s1", label: "Chrome on Mac", email: "maya@example.com", scopes: ["admin", "client"], expiresAt: 0 },
  "/api/auth/sessions": { sessions: [{ id: "s1" }], current: "s1" }, "/api/routines": { routines: [], runs: [] }, "/api/webhooks": { webhooks: [], attempts: [] },
  "/api/bots": { bots: [{ id: "chief", name: "Chief", threadId: "t-chief" }], groups: [] },
  "/api/connectors/catalog": { cards: CARDS, source: "api", configured: true, mode: "managed", setup: "ready" },
  "/api/connectors/connected": { services, inventoryComplete: true },
  "/api/connectors/suggestions": { cards: [], pick: "picked" },
  "/api/x/status": { using: null, ownKey: false, included: false },
  "/api/email": { accounts: [] },
  "/api/mcp/servers": { servers: [] },
  "/api/team/my-connections": { apps: [{ slug: "gmail", name: "Gmail", connected: true }, { slug: "notion", name: "Notion", connected: false }] },
};
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
  if (url.pathname.startsWith("/api/github/sign-in")) {
    if (gh === "hidden") return reply({ error: "Sign in to this team's Cloud to connect your own GitHub." }, 403);
    if (url.pathname.endsWith("/start")) return reply({ error: "GitHub is already signed in on this computer." }, 409);
    if (url.pathname.endsWith("/token")) return reply({ error: "GitHub did not accept this token." }, 400);
    return reply(github);
  }
  if (url.pathname.includes("/connector-cards/")) return reply({ connected: false, pending: false, status: "required" });
  return reply(ANSWERS[url.pathname] ?? {});
};
class QuietEventSource {
  onopen: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 1;
  constructor(readonly url: string) { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "run:0" }) }), 50); }
  addEventListener() {} removeEventListener() {} close() {}
}
Object.assign(window, { EventSource: QuietEventSource });
try { localStorage.setItem("omb-advanced-mode", "0"); } catch { /* blocked storage */ }

const [{ StoreProvider }, { useStoreDispatch, useStoreSelector }, { PluginsPanel }, { MemberApps }, { ConnectorCard }, { githubSignIn }, { applySkin, readSkin, SKIN_IDS }, { loadLocale }] = await Promise.all([
  import("@/state/store"), import("@/state/store-select"), import("@/components/PluginsPanel"), import("@/components/MemberApps"), import("@/components/ConnectorCard"),
  import("@/lib/github-sign-in"), import("@/lib/skins"), import("@/lib/i18n"),
]);

/** The refused states are reached as a person reaches them: Connect, then Paste a token instead (then a refused token). */
async function walkToRefusal() {
  if (gh !== "refused" && gh !== "token-error") return;
  while (githubSignIn.snapshot().phase === "loading") await new Promise((done) => setTimeout(done, 50));
  await githubSignIn.start();
  await new Promise((done) => setTimeout(done, 50));
  document.querySelector<HTMLButtonElement>("[data-github-refused] button")?.click();
  if (gh === "token-error") await githubSignIn.saveToken("github_pat_preview_only_not_a_real_token");
}

function AppsView() {
  const configured = useStoreSelector((state) => Boolean(state.config));
  const open = useStoreSelector((state) => state.pluginsOpen);
  const dispatch = useStoreDispatch();
  useEffect(() => { if (configured) dispatch({ type: "togglePlugins", open: true, surface: "apps" }); }, [configured]);
  useEffect(() => {
    if (!open) return;
    const search = params.get("q");
    const field = document.querySelector<HTMLInputElement>("[data-tour='apps-panel'] input");
    if (search && field) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, search);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    void walkToRefusal();
  }, [open]);
  if (!open) return <div className="h-screen bg-app" />;
  return <div className="h-screen bg-app">{view === "member" ? <MemberApps /> : <PluginsPanel />}</div>;
}

function ChatView() {
  useEffect(() => { void walkToRefusal(); }, []);
  const message = {
    id: "m-github", role: "bot" as const, kind: "connector" as const, at: AT,
    text: "Chief couldn't push to acme-labs/website: GitHub isn't connected.",
    connector: { source: "github" as const, slug: "github-sign-in", label: "GitHub", status: "required" as const, resumeKey: "github-preview",
      description: "Connect GitHub so Chief can push its work to your repositories." },
  };
  return (
    <div className="flex min-h-screen justify-center bg-app px-4 py-10 text-ink">
      <div className="flex w-full max-w-[720px] flex-col gap-4">
        <div className="max-w-[560px] self-end rounded-4xl bg-raised px-4 py-2.5 text-[15px] leading-[22px]">Push the landing page fix to acme-labs/website.</div>
        <div className="text-[15px] leading-[22px] text-ink">I made the fix on a branch, but pushing it needs GitHub.</div>
        <ConnectorCard botId="chief" color="blue" threadId="t-chief" message={message as never} />
      </div>
    </div>
  );
}

/** The pictures are taken once GitHub is in view: this row, else the GitHub app's tile, else the chat's card. */
function markReady() {
  const started = Date.now();
  const timer = setInterval(() => {
    const target = document.querySelector<HTMLElement>("[data-native-card='github'].contents [data-app-tile], [data-app-tile='github-sign-in'], [data-app-tile='github'], [data-ask-card]");
    const settled = gh === "refused" || gh === "token-error" ? document.querySelector(gh === "refused" ? "[data-github-token-form]" : "[data-github-refused] ~ [role='alert']") : true;
    if ((target && settled) || Date.now() - started > 8_000) {
      clearInterval(timer);
      target?.scrollIntoView({ block: "center" });
      requestAnimationFrame(() => document.body.setAttribute("data-preview-ready", ""));
    }
  }, 150);
}
markReady();

const asked = params.get("skin");
applySkin((SKIN_IDS as readonly string[]).includes(asked ?? "") ? asked as Parameters<typeof applySkin>[0] : readSkin());
await loadLocale(params.get("lang") ?? "en");
createRoot(document.getElementById("root")!).render(<StrictMode><StoreProvider>{view === "chat" ? <ChatView /> : <AppsView />}</StoreProvider></StrictMode>);
