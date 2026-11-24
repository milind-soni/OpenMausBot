// Dev-only gallery of moving a bot from this computer to My Cloud, served at /move-preview.html; not in the packaged app.
// It mounts the real confirm, chooser and line over fake bridges, with no server behind them.
// ?state=confirm|confirm-more|chooser|chooser-end|done|intro&skin=midnight|daylight&lang=de
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { CloudOffer } from "../electron/cloud-home.mjs";
import { CloudTrialIntroCard } from "@/components/CloudTrialIntro";
import { BotMoveLine, MoveChooser, useMoveToMyCloud } from "@/components/MoveToMyCloud";
import { loadLocale } from "@/lib/i18n";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import "./styles.css";

const params = new URLSearchParams(location.search);
const stateName = params.get("state") ?? "confirm";
const skin = params.get("skin") ?? "midnight";
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");
await loadLocale(params.get("lang") ?? "en");

const bots = [{ id: "dev", name: "Dev Helper" }, { id: "notes", name: "Release Notes" }, { id: "inbox", name: "Inbox Triage" }, { id: "research", name: "Research" }];
// A bot that works in a folder here, runs on Ollama, uses a command MCP server and a skill that reads ~/.claude, and hands
// work to a bot that stays: everything the step can say.
const facts = { folder: "/Volumes/Work/shop-app", folders: 1, engine: "Ollama", tools: ["git"], skills: ["standup-notes"], hidden: ["~/.claude"], teammates: ["Release Notes"] };
const lending = { paused: false, folderLent: false, terminal: false };
Object.assign(window, { ogb: {
  cloudSendPage: {
    botMoveState: async () => ({ available: true, moving: [] }),
    botChoices: async () => ({ bots }),
    moveChanges: async (ids: string[]) => ({ facts: ids.length > 1 ? { ...facts, folders: 2, teammates: ["Release Notes"] } : facts, lending }),
    moveBots: async () => ({ available: true, moving: [] }), moveEverything: async () => ({ available: true, moving: [] }),
    openMyCloud: async () => {}, botMoveRetry: async () => null, dismiss: async () => ({}),
  },
  placesTogether: { state: async () => ({ v: 1, available: true, on: false, here: "computer", other: null }), set: async () => ({ v: 1, available: true, on: true, here: "computer", other: null }), onChanged: () => () => {} },
} });

const allowances = { cpus: 2, cpuKind: "shared" as const, memoryMb: 2048, diskGb: 10, maxDiskGb: 20, computers: 15, computerHours: 100, voiceCharacters: 30_000, snapshotDays: 14 };
const OFFER: CloudOffer = { recommended: "pro", creditUsd: 5, reminderDays: 1, refundDays: 14, plans: [
  { tier: "starter", label: "Starter", amount: 1500, trialDays: 3, allowances }, { tier: "pro", label: "Pro", amount: 4900, trialDays: 3, allowances },
] };

/** Clicks what each selector finds, in turn, once it shows; then marks the page ready for pictures. */
function useClicks(selectors: string[]) {
  useEffect(() => {
    let next = 0;
    const timer = setInterval(() => {
      const target = document.querySelector<HTMLElement>(selectors[next] ?? "");
      if (!target) return;
      target.click();
      if (++next < selectors.length) return;
      clearInterval(timer);
      // What a choice changes is read a moment after the last tick: pictures wait for it.
      setTimeout(() => {
        // chooser-end: the chooser scrolled down to what the bots may use here, and Move.
        if (stateName === "chooser-end") document.querySelector("[data-move-chooser]")?.scrollTo({ top: 10_000 });
        document.body.dataset.previewReady = "1";
      }, 800);
    }, 120);
    return () => clearInterval(timer);
  }, []);
}

function Confirm({ more }: { more: boolean }) {
  const move = useMoveToMyCloud();
  useClicks(["[data-preview-item]", ...(more ? ["[data-move-changes-more]"] : [])]);
  const item = (_icon: unknown, label: string, onClick?: () => void) => <button key={label} type="button" data-preview-item="" className="sr-only" onClick={onClick}>{label}</button>;
  return <>{move.items(bots[0] as never, item as never)}{move.dialog}</>;
}

function Chooser() {
  useClicks(['[data-move-bot="dev"]', '[data-move-bot="research"]']);
  return <MoveChooser onClose={() => {}} />;
}

function Gallery() {
  return <div className="flex h-screen flex-col bg-canvas text-ink">
    {stateName === "done" && <BotMoveLine move={{ bot: { id: "bots-1", name: "Dev Helper" }, team: { id: "my-cloud", name: "My Cloud" }, phase: "done", bots: 1 } as never} onChange={() => {}} />}
    {stateName.startsWith("confirm") && <Confirm more={stateName === "confirm-more"} />}
    {stateName.startsWith("chooser") && <Chooser />}
    {stateName === "intro" && <div className="fixed bottom-4 end-4 w-[min(360px,calc(100vw-32px))]"><CloudTrialIntroCard offer={OFFER} {...{ botsHere: true }} onStart={() => {}} onHowTo={() => {}} onNotNow={() => {}} onDismiss={() => {}} /></div>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>);
