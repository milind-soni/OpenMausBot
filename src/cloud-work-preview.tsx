// Dev-only gallery of what the desktop window says while My Cloud doesn't answer, served at /cloud-work-preview.html; not in
// the packaged app. It mounts the real HomeScreen (this computer's screen) and the real LiveConnectionStrip (the strip on My
// Cloud's own page) over fake bridges, with no server behind them.
// ?state=update|update-later|update-late|update-backup|resize|move|disk|restore|start|waking|unreachable|unreachable-host|payment
//   |strip|strip-help|strip-update|strip-update-late|chat-not-sent&era=today|now&skin=midnight|daylight&lang=de
// `era=today` shows what each moment looks like without the Admin's `operation` (what an app before it, or an older Admin, shows).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { HomeBridge, HomeView } from "../electron/home-window.mjs";
import { ChatErrorBanner } from "@/components/ChatErrorBanner";
import { HomeScreen } from "@/components/HomeScreen";
import { LiveConnectionStrip } from "@/components/LiveConnectionStrip";
import { loadLocale } from "@/lib/i18n";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import "./styles.css";

const params = new URLSearchParams(location.search);
const stateName = params.get("state") ?? "update";
const era = params.get("era") === "today" ? "today" : "now";
const skin = params.get("skin") ?? "midnight";
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");
await loadLocale(params.get("lang") ?? "en");

// The strip waits 4 s, then 20 s, before it says more: the gallery runs those waits at once.
const realTimeout = window.setTimeout.bind(window);
if (stateName.startsWith("strip") || stateName === "chat-not-sent") Object.assign(window, { setTimeout: (work: () => void, ms?: number) => realTimeout(work, Math.min(ms ?? 0, 30)) });

const MINUTE = 60_000, now = Date.now();
/** What the Admin says (its session's `cloud.operation`) at each moment, as the gallery fakes it. */
const OPERATIONS: Record<string, Record<string, unknown>> = {
  update: { kind: "update", since: now - 40_000, until: now + 17 * MINUTE, expectedAt: now + 2 * MINUTE },
  "update-later": { kind: "update", since: now - 5 * MINUTE, until: now + 13 * MINUTE, expectedAt: now - 2 * MINUTE },
  "update-late": { kind: "update", since: now - 25 * MINUTE, until: now - 7 * MINUTE, expectedAt: now - 22 * MINUTE },
  "update-backup": { kind: "update", since: now - 3 * MINUTE, until: now + 177 * MINUTE, expectedAt: now + 68 * MINUTE, backup: true },
  resize: { kind: "resize", since: now - 30_000, until: now + 17 * MINUTE, expectedAt: now + 2 * MINUTE, bigger: true },
  move: { kind: "move", since: now - 4 * MINUTE, until: now + 60 * MINUTE },
  disk: { kind: "disk", since: now - 4 * MINUTE, until: now + 30 * MINUTE },
  restore: { kind: "restore", since: now - 2 * MINUTE, until: now + 28 * MINUTE },
  start: { kind: "start", since: now - MINUTE, until: now + 29 * MINUTE },
};
OPERATIONS["strip-update"] = OPERATIONS.update!;
OPERATIONS["strip-update-late"] = OPERATIONS["update-late"]!;
OPERATIONS["chat-not-sent"] = OPERATIONS.update!;
const operation = era === "now" ? OPERATIONS[stateName] ?? null : null;

/** This computer's screen at each moment. Without an operation, what it shows today: an update or move restarting My Cloud
 * reads as "can't reach" (the Admin keeps its health checks off it, so it names no reason), a start as setting up. */
function viewOf(): HomeView {
  if (stateName === "waking") return { screen: "waking" };
  if (stateName === "unreachable") return { screen: "offline", reason: "", cause: "no_answer" };
  if (stateName === "unreachable-host") return { screen: "offline", reason: "", cause: "host" };
  if (stateName === "payment") return { screen: "plan", machine: "payment-problem" };
  if (operation) return { screen: "working", operation } as unknown as HomeView;
  if (stateName === "start") return { screen: "setup", step: "starting" };
  return { screen: "offline" };
}
const view = viewOf();
const bridge = { state: async () => view, onState: () => () => {}, retry: async () => view, signIn: async () => {}, repair: async () => {} } as unknown as HomeBridge;
Object.assign(window, { ogb: { home: { ...bridge, operation: async () => operation } } });

function Gallery() {
  if (stateName.startsWith("strip") || stateName === "chat-not-sent") {
    // The strip on the Cloud's own page while its live stream is down; for a send that failed meanwhile, the chat's error line
    // above the composer too.
    return <div className="flex h-screen flex-col bg-canvas text-ink">
      <LiveConnectionStrip connected={false} hydrated />
      <div className="flex-1" />
      {stateName === "chat-not-sent" && <div className="pb-6"><ChatErrorBanner message="TypeError: Failed to fetch" onDismiss={() => {}} /></div>}
    </div>;
  }
  return <HomeScreen bridge={bridge} manage={async () => {}} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>);
