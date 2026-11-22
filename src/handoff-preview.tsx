// Dev-only gallery of a bot handing a step to the person, served at /handoff-preview.html; not in the packaged app. It
// mounts the real chat, sidebar and viewer pill over a fixed store with no server behind it.
// ?view=pending|connecting|stack|collapsed|suggest-waiting|pill-watching|pill-control|pill-request|sidebar|site&skin=midnight|daylight
import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { SignInRequestCardData } from "../shared/wire";
import { ChatView } from "@/components/ChatView";
import { HandoffSuggestion } from "@/components/HandoffSuggestion";
import { Sidebar } from "@/components/Sidebar";
import { ViewerPill } from "@/components/ViewerPill";
import { setAdvancedMode } from "@/lib/interface-mode";
import { publishLiveFrame } from "@/lib/live-events";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import { initialState, StoreContext, type AppState, type Bot, type Message } from "@/state/store";
import "./styles.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "pending";
const skin = params.get("skin") ?? "midnight";
setAdvancedMode(false);
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");

const AT = Date.now() - 6 * 60_000;
const THREAD = "scout-github";
const INSTRUCTION = "Sign in to GitHub on the open page, then press I'm done.";
const message = (id: string, minutes: number, fields: Partial<Message>): Message =>
  ({ id, at: AT + minutes * 60_000, role: "bot", kind: "text", text: "", ...fields }) as Message;
const handoff = (fields: Partial<SignInRequestCardData> = {}): SignInRequestCardData => ({
  url: "https://github.com/", site: "github.com", place: "browser", instruction: INSTRUCTION, need: "sign_in", expiresAt: Date.now() + 28 * 60_000, ...fields,
});

/** A stand-in page: a plain sign-in form, drawn here. */
const PAGE = `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
<rect width="1280" height="800" fill="#ffffff"/><rect width="1280" height="44" fill="#eef1f5"/><rect x="12" y="8" width="220" height="28" rx="8" fill="#ffffff"/>
<text x="28" y="27" font-family="Helvetica,Arial" font-size="13" fill="#444">Sign in - GitHub</text><rect x="0" y="44" width="1280" height="40" fill="#f6f8fa"/>
<rect x="90" y="51" width="1100" height="26" rx="13" fill="#ffffff" stroke="#d0d7de"/><text x="110" y="69" font-family="Helvetica,Arial" font-size="13" fill="#57606a">github.com/login</text>
<circle cx="640" cy="170" r="26" fill="#24292f"/><text x="640" y="245" text-anchor="middle" font-family="Helvetica,Arial" font-size="24" fill="#24292f">Sign in to GitHub</text>
<rect x="500" y="275" width="280" height="230" rx="8" fill="#f6f8fa" stroke="#d0d7de"/><text x="520" y="305" font-family="Helvetica,Arial" font-size="14" fill="#24292f">Username or email address</text>
<rect x="520" y="315" width="240" height="34" rx="6" fill="#ffffff" stroke="#d0d7de"/><text x="520" y="380" font-family="Helvetica,Arial" font-size="14" fill="#24292f">Password</text>
<rect x="520" y="390" width="240" height="34" rx="6" fill="#ffffff" stroke="#d0d7de"/><rect x="520" y="445" width="240" height="36" rx="6" fill="#1f883d"/>
<text x="640" y="468" text-anchor="middle" font-family="Helvetica,Arial" font-size="14" fill="#ffffff">Sign in</text></svg>`)}`;

function messages(): Message[] {
  const opening = [
    message("ask", 0, { role: "user", text: "Read the open issues on our GitHub repo and summarise them." }),
    message("reply", 1, { text: "I need to be signed in to GitHub for that. The sign-in page is open in my browser; over to you for this one step." }),
  ];
  if (view === "collapsed") return [...opening,
    message("card", 2, { kind: "signin", text: INSTRUCTION, signIn: handoff({ done: true, resumed: true }) }),
    message("after", 3, { text: "Thanks. I can see your avatar in the top bar, so you're signed in. Reading the issues now." }),
  ];
  if (view === "stack") return [...opening,
    message("card", 2, { kind: "signin", text: INSTRUCTION, signIn: handoff({ need: "sign_in" }) }),
    message("card2", 3, { kind: "signin", text: "Solve the human check on the page.", signIn: handoff({ need: "captcha", instruction: "Solve the human check on the page.", site: "", url: "" }) }),
  ];
  if (view === "site") return [...opening,
    message("card", 2, { kind: "signin", signIn: { url: "https://github.com/login", site: "github.com", place: "browser", reason: "To read the issues on your repositories" } }),
  ];
  return [...opening, message("card", 2, { kind: "signin", text: INSTRUCTION, signIn: handoff() })];
}

const bot: Bot = {
  title: "", description: "", notifications: true, unread: false, modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
  id: "scout", name: "Scout", color: "teal", threadId: THREAD, mainThreadId: THREAD, busy: false, activity: view === "collapsed" ? "idle" : "waiting-on-you",
  tasks: [{ threadId: THREAD, title: "GitHub issues", createdAt: AT, ...(view === "collapsed" ? {} : { activity: "waiting-on-you" }) }], messages: messages(),
} as Bot;
const others: Bot[] = [
  { ...bot, id: "ledger", name: "Ledger", color: "orange", threadId: "ledger-main", mainThreadId: "ledger-main", activity: "idle", tasks: [{ threadId: "ledger-main", title: "Invoices", createdAt: AT }],
    messages: [message("l1", 0, { text: "The March invoices are filed in your Drive." })] } as Bot,
  { ...bot, id: "atlas", name: "Atlas", color: "blue", threadId: "atlas-main", mainThreadId: "atlas-main", activity: "idle", tasks: [{ threadId: "atlas-main", title: "Trip", createdAt: AT }],
    messages: [message("a1", 0, { text: "Booked: the 9:40 train to Leeds on Friday." })] } as Bot,
];

const GITHUB = { slug: "github", label: "GitHub", blurb: "Code hosting", logo: null, domain: null };

function Frame({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh w-full overflow-hidden bg-app text-ink">{children}</div>;
}

function Viewer({ state }: { state: "watching" | "control" | "control-request" }) {
  return (
    <div className="fixed inset-0 flex flex-col bg-card text-ink" data-preview="viewer">
      <div className="flex h-11 shrink-0 items-center border-b border-hairline/40 px-4 text-[13px] text-ink-secondary">github.com/login</div>
      <div className="relative min-h-0 flex-1 bg-inset/40">
        <img src={PAGE} alt="" className="absolute inset-0 h-full w-full object-contain" />
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
          <ViewerPill state={state} onTake={() => undefined} onStop={() => undefined} onDone={() => undefined} />
        </div>
      </div>
    </div>
  );
}

function Gallery() {
  useEffect(() => {
    if (view === "connecting") return;
    const send = () => publishLiveFrame({ kind: "screen", botId: bot.id, threadId: THREAD, png: PAGE.slice(PAGE.indexOf(",") + 1), mime: "image/svg+xml", surface: "browser" });
    const timer = setInterval(send, 300);
    send();
    return () => clearInterval(timer);
  }, []);
  const bots = [bot, ...others];
  const state: AppState = { ...initialState, bots, selectedId: bot.id, connected: true };
  const value = { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  if (view.startsWith("pill-")) return <Viewer state={view === "pill-watching" ? "watching" : view === "pill-control" ? "control" : "control-request"} />;
  return (
    <StoreContext.Provider value={value}>
      {view === "suggest-waiting" ? (
        <Frame><div className="mx-auto w-full max-w-[600px] p-6" data-preview={view}>
          <HandoffSuggestion app={GITHUB} status={{ connected: false }} request={{ botId: bot.id, threadId: THREAD, messageId: "card", place: "browser" }} botName="Scout" initialPhase="waiting" />
          <HandoffSuggestion app={GITHUB} status={{ connected: false }} request={{ botId: bot.id, threadId: THREAD, messageId: "card2", place: "browser" }} botName="Scout" initialPhase="connected" />
        </div></Frame>
      ) : view === "sidebar" ? (
        <Frame><div className="flex h-full w-[280px] shrink-0" data-preview={view}><Sidebar open onClose={() => {}} /></div><div className="flex min-w-0 flex-1 flex-col"><ChatView bot={bot} /></div></Frame>
      ) : (
        <Frame><div className="flex min-w-0 flex-1 flex-col" data-preview={view}><ChatView bot={bot} /></div></Frame>
      )}
    </StoreContext.Provider>
  );
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, location.href).pathname;
  if (!path.startsWith("/api/")) return realFetch(input, init);
  const body = path.endsWith("/saved-logins") ? { choices: [] }
    : path === "/api/connectors/catalog" ? { cards: [GITHUB], source: "api", configured: true, mode: "managed" }
      : path === "/api/connectors" ? { services: { github: { connected: false } } }
        : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>);
