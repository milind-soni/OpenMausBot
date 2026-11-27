// Dev-only gallery of the Inbox panel with every kind of line, served at /inbox-preview.html; not in the packaged app. It
// mounts the real sidebar Inbox row and the real panel over a fixed store, with no server behind it.
// ?scope=team|personal&skin=midnight|daylight&mode=simple|advanced&lang=de&reading=<line id>&only=activity
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { InboxRow, InboxView } from "../shared/inbox";
import { inboxGroup } from "../shared/inbox-reason";
import { InboxPanel } from "@/components/inbox/InboxPanel";
import { SidebarInboxRow } from "@/components/SidebarInboxRow";
import { loadLocale } from "@/lib/i18n";
import { setAdvancedMode } from "@/lib/interface-mode";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import { currentInbox, openInbox, setInboxView } from "@/state/inbox";
import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { setTeamPeople } from "@/state/team-people";
import "./styles.css";

const params = new URLSearchParams(location.search);
const team = params.get("scope") !== "personal";
const skin = params.get("skin") ?? "midnight";
setAdvancedMode(params.get("mode") === "advanced");
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");
await loadLocale(params.get("lang") ?? "en");

const NOW = Date.now();
const ago = (minutes: number) => NOW - minutes * 60_000;
const BEN = { name: "Ben", email: "ben@acme.test" };
const LEDGER = { name: "Ledger", botId: "ledger" };
const SCOUT = { name: "Scout", botId: "scout" };
const origin = (botId: string, threadId: string, title: string, groupId?: string) => ({ botId, threadId, title, ...(groupId ? { groupId } : {}) });

const question: InboxRow = {
  id: "question", kind: "ask", tab: "needs-you", unread: true, at: ago(3), from: LEDGER, origin: origin("ledger", "ledger-work", "Pricing page: fix"),
  text: "Should I apply the fix to the pricing page?",
  card: { title: "Your bot has a question", subtitle: "Should I apply the fix to the pricing page?", options: ["Yes, only the footer", "Yes, the welcome text too", "No"], requestId: "req-q", requestType: "question" },
};
const approval: InboxRow = {
  id: "approval", kind: "ask", tab: "needs-you", unread: false, at: ago(26), from: LEDGER, origin: origin("ledger", "ledger-work", "Pricing page: fix"),
  text: "git push origin fix/pricing-page-footer",
  card: { title: "Approval needed", subtitle: "git push origin fix/pricing-page-footer", options: ["Allow", "Deny"], requestId: "req-a", requestType: "permission", tool: "Bash" },
};
const finished: InboxRow = {
  id: "finished", kind: "result", tab: "info", unread: true, at: ago(15), from: SCOUT, origin: origin("scout", "scout-weekly", "Weekly report"),
  text: "Weekly report is ready: 4 new leads, 2 replies still open.",
};
const finishedRead: InboxRow = {
  id: "finished-read", kind: "result", tab: "info", unread: false, at: ago(190), from: SCOUT, origin: origin("scout", "scout-daily", "Daily summary"),
  text: "Daily summary: 3 new leads, 1 reply open.",
};

const teamRows: InboxRow[] = [
  question,
  { id: "mention", kind: "message", tab: "info", unread: true, at: ago(8), from: BEN, origin: { ...origin("ledger", "room-design", "Design", "design"), messageId: "m1" }, replies: true, reason: "mentioned",
    text: "@Cleo can you look at the new header before Friday?" },
  finished,
  approval,
  { id: "reply", kind: "message", tab: "info", unread: true, at: ago(41), from: BEN, origin: { ...origin("ledger", "room-launch", "Launch plan", "launch"), messageId: "m2" }, replies: true, reason: "replied",
    text: "Yes, Thursday works. I'll take the slides." },
  { id: "message", kind: "message", tab: "info", unread: false, at: ago(64), from: LEDGER, origin: origin("ledger", "ledger-deploy", "Staging deploy"), replies: true,
    text: "The staging deploy is done. Want me to ship it to everyone?" },
  { id: "shared", kind: "notice", tab: "info", unread: true, at: ago(130), from: BEN, origin: origin("ledger", "ledger-main", "Ledger"), reason: "shared",
    text: "Ben shared Ledger with you." },
  finishedRead,
];

const personalRows: InboxRow[] = [
  question,
  finished,
  approval,
  { id: "message", kind: "message", tab: "info", unread: true, at: ago(52), from: LEDGER, origin: origin("ledger", "ledger-deploy", "Staging deploy"), replies: true,
    text: "The staging deploy is done. Want me to ship it to everyone?" },
  { id: "notice", kind: "notice", tab: "info", unread: false, at: ago(95), from: SCOUT, origin: origin("scout", "scout-crm", "CRM sync"),
    text: "The CRM sync stopped: the sign-in to the CRM expired." },
  finishedRead,
];

const BASE = { title: "", description: "", notifications: true, unread: false, modelSelection: { instanceId: "claude", model: "claude-opus-5-5" } } as const;
const bots: Bot[] = [
  { ...BASE, id: "ledger", name: "Ledger", title: "Developer", color: "teal", threadId: "ledger-work", tasks: [{ threadId: "ledger-work", title: "Pricing page: fix", createdAt: ago(600) }], messages: [] },
  { ...BASE, id: "scout", name: "Scout", title: "Cleo's Chief", color: "orange", chiefOfStaff: team, threadId: "scout-inbox",
    tasks: [{ threadId: "scout-inbox", title: "Inbox", createdAt: ago(6000), ...(team ? { inbox: true } : {}) }], messages: [] },
] as Bot[];

const rows = (team ? teamRows : personalRows).filter((row) => params.get("only") !== "activity" || inboxGroup(row) === "activity");
const view: InboxView = team ? { botId: "scout", threadId: "scout-inbox", rows, anchor: rows[0]!.id } : { botId: null, threadId: null, rows, anchor: null };
setInboxView(view);
openInbox(params.get("reading") ? { reading: params.get("reading")! } : {});
if (team) setTeamPeople({ people: [{ email: "cleo@acme.test", name: "Cleo", role: "owner", you: true }, { ...BEN, role: "member" }], me: { email: "cleo@acme.test", name: "Cleo", role: "owner", you: true }, admin: true, needsYou: [] });

function Gallery() {
  const state: AppState = { ...initialState, bots, selectedId: "scout", connected: true };
  const value = { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  return (
    <StoreContext.Provider value={value}>
      <div className="flex h-dvh w-full overflow-hidden bg-app text-ink">
        <nav className="w-[260px] shrink-0 border-e border-hairline/40 bg-panel pt-3 max-md:hidden"><SidebarInboxRow icons={false} large running={false} /></nav>
        <main className="min-w-0 flex-1" />
        <InboxPanel />
      </div>
    </StoreContext.Provider>
  );
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, location.href).pathname;
  if (!path.startsWith("/api/")) return realFetch(input, init);
  const marked = /^\/api\/inbox\/([\w-]+)\/(read|unread)$/.exec(path);
  if (marked) {
    const shown = currentInbox() ?? view;
    const next = { ...shown, rows: shown.rows.map((row) => (row.id === marked[1] ? { ...row, unread: marked[2] === "unread" } : row)) };
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(path === "/api/inbox" ? JSON.stringify(currentInbox() ?? view) : "{}", { status: 200, headers: { "content-type": "application/json" } });
};

createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>);
