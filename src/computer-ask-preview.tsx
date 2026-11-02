// Dev-only gallery of what the person sees when their own Cloud can't use their PC, served at /computer-ask-preview.html;
// not in the packaged app. It mounts the real chat over a fixed store with no server behind it, and this PC's own
// screen-control status over fixed desktop capabilities.
// ?view=asking|closed|failed|on|pc&skin=midnight|daylight
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ComputerAskCard } from "../shared/computer-ask";
import { ChatView } from "@/components/ChatView";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { WindowsLocalControl } from "@/components/WindowsLocalControl";
import { setAdvancedMode } from "@/lib/interface-mode";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import { initialState, StoreContext, type AppState, type Bot, type Message } from "@/state/store";
import "./styles.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "asking";
const skin = params.get("skin") ?? "midnight";
setAdvancedMode(false);
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");

const AT = Date.now() - 6 * 60_000;
const THREAD = "scout-invoice";
const message = (id: string, minutes: number, fields: Partial<Message>): Message =>
  ({ id, at: AT + minutes * 60_000, role: "bot", kind: "text", text: "", ...fields }) as Message;

const ASK: Record<string, { ask: Partial<ComputerAskCard>; answered?: string }> = {
  asking: { ask: { reason: "not-running", state: "asking" } },
  closed: { ask: { reason: "closed", state: "asking" } },
  failed: { ask: { reason: "blocked", state: "failed" } },
  on: { ask: { reason: "not-running", state: "on" }, answered: "allow" },
};

function messages(): Message[] {
  const shown = ASK[view] ?? ASK.asking!;
  const card = {
    title: "Scout wants to use your PC's apps and screen", subtitle: "", options: ["Turn on", "Not now"], requestId: "ask-1", requestType: "permission" as const,
    tool: "turn_on_your_computer", ...(shown.answered ? { answered: shown.answered } : {}),
    computerAsk: { need: "screen", device: "PC", why: "Fill in this month's invoice in Excel and save it as a PDF", ...shown.ask } as ComputerAskCard,
  };
  return [
    message("ask", 0, { role: "user", text: "Can you fill in this month's invoice in Excel on my PC and save it as a PDF?" }),
    message("reply", 1, { text: "I'll do it in Excel on your PC." }),
    message("card", 2, { kind: "options", card }),
    ...(view === "on" ? [message("after", 4, { text: "Your PC is on. Opening Excel now." })] : []),
  ];
}

const bot: Bot = {
  title: "", description: "", notifications: true, unread: false, modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
  id: "scout", name: "Scout", color: "teal", threadId: THREAD, mainThreadId: THREAD, busy: view !== "on", activity: view === "on" ? "working" : "waiting-on-you",
  tasks: [{ threadId: THREAD, title: "Invoice in Excel", createdAt: AT }], messages: messages(),
} as Bot;

function Frame({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh w-full overflow-hidden bg-app text-ink">{children}</div>;
}

function Gallery() {
  if (view === "pc") {
    return (
      <DesktopCapabilitiesProvider>
        <Frame><div className="mx-auto w-full max-w-[460px] p-6" data-preview="pc"><WindowsLocalControl /></div></Frame>
      </DesktopCapabilitiesProvider>
    );
  }
  const state: AppState = { ...initialState, bots: [bot], selectedId: bot.id, connected: true };
  const value = { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  return (
    <StoreContext.Provider value={value}>
      <Frame><div className="flex min-w-0 flex-1 flex-col" data-preview="chat"><ChatView bot={bot} /></div></Frame>
    </StoreContext.Provider>
  );
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!new URL(url, location.href).pathname.startsWith("/api/")) return realFetch(input, init);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
const blocked = "embedded host failed: Spawn: binaryPath C:\\Users\\you\\AppData\\Local\\Programs\\OpenMausBot\\resources\\cua-driver-background.exe; reason Operation did not complete successfully because the file contains a virus or potentially unwanted software. (os error 225)";
const capabilities = {
  remote: false, host: { platform: "win32", label: "Windows", session: "unknown", packaged: true, homeDir: "C:\\Users\\you" }, windowChrome: "win-caption",
  screenPreview: { available: false, interaction: "none", reasonCode: "unsupported-platform" }, dictation: { available: false, engine: "none", onDevice: false },
  localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable", reasonCode: "cua-driver-blocked", message: blocked },
};
if (view === "pc") {
  Object.assign(window, { ogb: { platform: "win32", getCapabilities: async () => capabilities, onCapabilitiesChanged: () => () => {}, localControl: { retry: async () => ({}) } } });
}

createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>);
