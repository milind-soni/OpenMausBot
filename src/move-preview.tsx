// Dev-only gallery of moving a bot from this computer to My Cloud or into the person's team, served at /move-preview.html;
// not in the packaged app. It mounts the real confirm, chooser, menu rows, team card and line over fake bridges, with no
// server behind them. `old=1`: the bridges answer as a main that offered no team move from this computer.
// ?state=confirm|confirm-more|chooser|chooser-end|done|intro|team-menu|team-confirm|team-chooser|team-line|team-line-failed|team-bring&skin=midnight|daylight&lang=de
import { StrictMode, useEffect, type ReactNode } from "react";
import { Archive, ClipboardCopy, Copy, UserPen } from "lucide-react";
import { createRoot } from "react-dom/client";
import type { CloudOffer } from "../electron/cloud-home.mjs";
import { CloudTrialIntroCard } from "@/components/CloudTrialIntro";
import { BotMoveLine, MoveChooser, useMoveToMyCloud } from "@/components/MoveToMyCloud";
import { TeamMoveLine, useMoveToTeam } from "@/components/MoveToTeam";
import { WelcomeBring } from "@/components/cloud-welcome/WelcomeBring";
import { MENU_ITEM, MENU_ITEM_SEPARATOR, MENU_SHEET } from "@/components/menu-recipe";
import { cn } from "@/lib/cn";
import { loadLocale, t } from "@/lib/i18n";
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
const old = params.get("old") === "1";
const ACME = { id: "team-acme", name: "Acme", ready: true };
const here = [{ id: "maus", name: "MausBot", stays: "default" as const }, ...bots];
const moving = (phases: Array<"moving" | "failed" | "done">) => ({ bot: { id: "notes", name: "Release Notes" }, team: ACME, from: "computer" as const,
  phase: phases.includes("moving") ? "moving" as const : phases.includes("failed") ? "failed" as const : "done" as const,
  batch: phases.map((phase, i) => ({ id: bots[i]!.id, name: bots[i]!.name, phase })) });
Object.assign(window, { ogb: {
  cloudSendPage: {
    teams: async () => (old ? { teams: [] } : { teams: [ACME], from: "computer" }),
    teamChoices: async () => ({ bots: here }),
    moveToTeamMany: async () => ({ view: null }), moveToTeamCoded: async () => ({ view: null }), moveToTeam: async () => null,
    teamBring: async () => ({ team: ACME, bots: [], ...(old ? {} : { computer: here }) }),
    teamBringMove: async () => ({ started: false, move: null }), teamBringMany: async () => ({ started: false, move: null }), teamBringStatus: async () => null,
    teamRetry: async () => null, openTeam: async () => {},
    // The team states are a person whose only Cloud is their team's: no My Cloud to move to.
    botMoveState: async () => ({ available: !stateName.startsWith("team"), moving: [] }),
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

/** The lower part of a bot's menu on this computer's page, with the move rows the real hooks give it. */
function TeamMenu({ open }: { open: boolean }) {
  const team = useMoveToTeam({ blocked: () => undefined });
  const cloud = useMoveToMyCloud();
  useClicks(open ? ["[data-preview-team-item]"] : []);
  useEffect(() => { if (!open) setTimeout(() => { document.body.dataset.previewReady = "1"; }, 800); }, []);
  const item = (icon: ReactNode, label: string, onClick?: () => void, opts?: { disabled?: boolean; hint?: string }) => <button key={label} type="button" role="menuitem" title={opts?.hint}
    {...(label === t("teamMove.menu", { team: ACME.name }) ? { "data-preview-team-item": "" } : {})} disabled={opts?.disabled} onClick={onClick}
    className={cn(MENU_ITEM, "text-ink", opts?.disabled ? "cursor-default opacity-40" : "hover:bg-menu-hover")}>{icon}{label}</button>;
  const bot = { id: "dev", name: "Dev Helper", threadId: "dev-main", hidden: false } as never;
  return <>
    <div role="menu" data-look="menu" className={cn("fixed start-4 top-4 w-max min-w-[198px]", MENU_SHEET)}>
      {item(<UserPen size={16} className="text-ink-secondary" />, t("sidebar.bot.editProfile"))}
      {item(<Copy size={16} className="text-ink-secondary" />, t("sidebar.bot.duplicate"))}
      {item(<ClipboardCopy size={16} className="text-ink-secondary" />, t("sidebar.copyConversationId"))}
      <div role="separator" className={MENU_ITEM_SEPARATOR} />
      {team.items(bot, item as never)}{cloud.items(bot, item as never)}
      {item(<Archive size={16} className="text-ink-secondary" />, t("sidebar.bot.archive"))}
    </div>
    {team.dialog}{cloud.dialog}
  </>;
}

function TeamChooser() {
  useClicks(['[data-move-bot="research"]']);
  return <MoveChooser onClose={() => {}} team={{ name: ACME.name, chosen: ["dev"], move: async () => {} }} />;
}

function TeamBring() {
  useEffect(() => { setTimeout(() => { document.body.dataset.previewReady = "1"; }, 800); }, []);
  return <div className="mx-auto w-full max-w-[720px] overflow-y-auto p-4">
    <WelcomeBring name={ACME.name} desktop team cloudHasWork={false} headingRef={{ current: null }} onTeam={() => {}} onFinish={() => {}} />
  </div>;
}

function Gallery() {
  return <div className="flex h-screen flex-col bg-canvas text-ink">
    {stateName === "team-menu" && <TeamMenu open={false} />}
    {stateName === "team-confirm" && <TeamMenu open />}
    {stateName === "team-chooser" && <TeamChooser />}
    {stateName === "team-line" && <TeamMoveLine move={moving(["done", "moving", "moving", "moving"])} onChange={() => {}} />}
    {stateName === "team-line-failed" && <TeamMoveLine move={moving(["done", "failed", "done", "done"])} onChange={() => {}} />}
    {stateName === "team-bring" && <TeamBring />}
    {stateName === "done" && <BotMoveLine move={{ bot: { id: "bots-1", name: "Dev Helper" }, team: { id: "my-cloud", name: "My Cloud" }, phase: "done", bots: 1 } as never} onChange={() => {}} />}
    {stateName.startsWith("confirm") && <Confirm more={stateName === "confirm-more"} />}
    {stateName.startsWith("chooser") && <Chooser />}
    {stateName === "intro" && <div className="fixed bottom-4 end-4 w-[min(360px,calc(100vw-32px))]"><CloudTrialIntroCard offer={OFFER} {...{ botsHere: true }} onStart={() => {}} onHowTo={() => {}} onNotNow={() => {}} onDismiss={() => {}} /></div>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>);
