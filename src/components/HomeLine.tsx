import { useEffect, useState } from "react";
import { Cloud, Laptop, Users, X } from "lucide-react";
import { freeFallback } from "../../shared/ai-ranking";
import { engineReady } from "@/components/EngineLibrary";
import { ConnectAiDialog } from "@/components/onboarding/ConnectAi";
import { t } from "@/lib/i18n";
import { HOME_LINE_NOTICE, homeLineShown, homeLineStage } from "@/lib/notices";
import { hintSeenPatch } from "@/lib/onboarding";
import { computerName } from "@/lib/places";
import { setNotificationPlace } from "@/lib/notify";
import { api, useStore } from "@/state/store";

type Line = { kind: "left"; name: string } | { kind: "clean"; saved?: boolean } | { kind: "profile"; name?: string };

/** The words for main's one line: a team this person is no longer in, that the clean workspace isn't where their bots went (`saved`: the account they moved with is signed in here too, one click away on the rail), or that a workspace of this computer's own opened from the rail is separate from My Cloud (`name`: one added from ＋, separate from the rest). */
export function homeLineText(line: Line, platform?: string): string {
  if (line.kind === "profile") return line.name ? t("homeLine.local", { name: line.name }) : t("homeLine.profile", { name: computerName({ profile: "default" }, platform) });
  if (line.kind === "clean") return t(line.saved ? "homeLine.cleanSaved" : "homeLine.clean");
  return t("homeLine.left", { name: line.name });
}

/** The clean workspace and a profile skip the new-user setup, so connecting an AI is offered here while none is ready. Nothing
 * is sent to test one: nothing starts by itself in this workspace. */
function ConnectAiLink() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" data-home-line-ai className="underline underline-offset-2 hover:text-ink" onClick={() => setOpen(true)}>{t("onboarding.meet.connectAi")}</button>
    {open && <ConnectAiDialog tested={null} onClose={() => setOpen(false)} />}
  </>;
}

/** In the desktop app, never in a browser: one plain line main has for the next page, served once (home-places.mjs):
 * after a team dropped this person, that they are no longer in it. Nothing to press; it goes with the page. (Who can
 * see a team's private chats is said in the chat itself, by the team's own page.) Or, for as long as the clean workspace
 * runs (clean-workspace.mjs), that the person's bots are safe in their Cloud; Sign in stays in the You menu. In a profile, that
 * it is separate from My Cloud: words only, so its ✕ closes them for good in that workspace, and they go by themselves after
 * a few days (homeLineStage); connecting an AI stays offered while none is ready. */
export function HomeLine() {
  const bridge = !window.ogb?.remoteClient?.active ? window.ogb?.workspaces : undefined;
  const { state, dispatch } = useStore();
  const [line, setLine] = useState<Line | null>(null);
  const [closed, setClosed] = useState(false);
  const record = state.config?.onboarding;
  const informational = line?.kind === "profile";
  const stage = informational && record ? homeLineStage(record, Date.now()) : null;
  const save = (patch: ReturnType<typeof homeLineShown>) => {
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) }).then((config) => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  useEffect(() => { if (stage === "due") save(homeLineShown(record, Date.now())); }, [stage]);
  useEffect(() => {
    if (!bridge?.line) return;
    // Served once: the first ask gets the line even when a strict-mode remount asks again (and gets null, which must
    // not take it back); after a real unmount the set is a no-op.
    void bridge.line().then((next) => { if (next) setLine(next); }).catch(() => {});
    // A team's page (main's summary carries this person's role there): its notifications name the team.
    void bridge.state().then((place) => setNotificationPlace(place.role ? place.name : null)).catch(() => {});
  }, [bridge]);
  if (!line) return null;
  // Until this workspace's config says how often the words were shown, they wait, so a line already closed never flashes.
  const words = !informational || (stage === "due" && !closed);
  const aiMissing = line.kind !== "left" && !state.instances.some((instance) => engineReady(instance) && !freeFallback(instance));
  if (!words && !aiMissing) return null;
  return <div role="status" data-home-line={line.kind} className={`relative flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-hairline/40 bg-panel ${informational ? "px-8" : "px-3"} py-1.5 text-[13px] text-ink-secondary`}>
    {line.kind === "clean" ? <Cloud size={14} aria-hidden="true" /> : line.kind === "profile" ? <Laptop size={14} aria-hidden="true" /> : <Users size={14} aria-hidden="true" />}
    {words && <span dir="auto">{homeLineText(line, window.ogb?.platform)}</span>}
    {aiMissing && <ConnectAiLink />}
    {informational && words && <button type="button" data-home-line-close aria-label={t("common.close")} title={t("common.close")}
      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 hover:bg-hairline/40 hover:text-ink" onClick={() => { setClosed(true); save(hintSeenPatch(record, HOME_LINE_NOTICE)); }}>
      <X size={14} aria-hidden="true" />
    </button>}
  </div>;
}
