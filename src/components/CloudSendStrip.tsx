import { useEffect, useState } from "react";
import { CloudUpload, Loader2 } from "lucide-react";
import { MOVE_LINE } from "../../electron/cloud-send-parts.mjs";
import type { CloudSendNotice, CloudSendPageBridge } from "../../electron/cloud-send.mjs";
import { ipcErrorText, moveLine, moveQuietUntil } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";
import { TeamMoveLine } from "./MoveToTeam";

/** My Cloud's notice from main, kept fresh: undefined until main first answers, null when it can't. */
export function useCloudSendNotice(bridge: CloudSendPageBridge | undefined) {
  const [notice, setNotice] = useState<CloudSendNotice | null | undefined>(undefined);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const unsubscribe = bridge.onNotice((next) => { if (alive) setNotice(next); });
    void bridge.notice().then((next) => { if (alive) setNotice(next ?? null); }).catch(() => { if (alive) setNotice((known) => known ?? null); });
    return () => { alive = false; unsubscribe(); };
  }, [bridge]);
  return [notice, setNotice] as const;
}

/** The corner cards that sell or ask for something wait (moveQuietUntil): null until main first answers, then whether
 * they wait now. The time after the move is kept once its line is closed, and the page looks again when it is over. */
export function useMoveQuiet(now: () => number = Date.now): boolean | null {
  const bridge = !window.ogb?.remoteClient?.active ? window.ogb?.cloudSendPage : undefined;
  const [notice] = useCloudSendNotice(bridge);
  const [after, setAfter] = useState(0);
  const [, setLooked] = useState(0);
  const until = moveQuietUntil(notice?.move);
  useEffect(() => { if (Number.isFinite(until) && until > after) setAfter(until); }, [until, after]);
  const end = Math.max(after, until);
  useEffect(() => {
    if (!Number.isFinite(end) || end <= now()) return;
    const timer = setTimeout(() => setLooked((count) => count + 1), end - now());
    return () => clearTimeout(timer);
  }, [end]);
  if (bridge && notice === undefined) return null;
  return end > now();
}

/** In the desktop app, never in a browser: the one-time move's line on either page (on its way, what arrived, coming
 * home), and on My Cloud's page a bot's move into a team. Nothing to press while it goes; Try again only after a day of
 * failing (a bot's move into a team: as soon as it fails). */
export function CloudSendStrip({ cloudHome, onPairPhone }: { cloudHome: boolean; onPairPhone?: () => void }) {
  const bridge = !window.ogb?.remoteClient?.active ? window.ogb?.cloudSendPage : undefined;
  const [notice, setNotice] = useCloudSendNotice(bridge);
  const [retrying, setRetrying] = useState(false);
  const [unanswered, setUnanswered] = useState<string | null>(null);
  const move = notice?.move ? moveLine(notice.move, cloudHome ? "cloud" : "local") : null;
  if (bridge && !move && notice?.teamMove && cloudHome) return <TeamMoveLine move={notice.teamMove} onChange={(next) => setNotice({ ...notice, teamMove: next ?? undefined })} />;
  if (!bridge || !move) return null;
  const retry = () => {
    setRetrying(true);
    setUnanswered(null);
    void (bridge.moveRetry?.() ?? Promise.resolve(notice!)).then((next) => { setNotice(next); setRetrying(false); })
      .catch((cause: unknown) => { setUnanswered(ipcErrorText(cause) ?? t("cloudSend.move.failingPlain")); setRetrying(false); });
  };
  const close = () => { void bridge.dismiss(MOVE_LINE).then(setNotice).catch(() => {}); };
  return <div role="status" data-cloud-send-strip={move.kind} data-move-line={notice!.move!.phase} className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-hairline/40 bg-panel px-3 py-1.5 text-[12.5px] text-ink-secondary">
    {move.kind === "sending" || retrying ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <CloudUpload size={14} aria-hidden="true" />}
    <span dir="auto" data-cloud-send-strip-line>{unanswered ?? move.text}</span>
    {move.extra.map((line) => <span key={line} dir="auto" data-move-line-extra>{line}</span>)}
    {move.phone && onPairPhone && <>
      <button type="button" data-move-phone className="font-medium text-accent-text underline underline-offset-2 hover:text-ink" onClick={onPairPhone}>{t("cloudSend.move.phone")}</button>
      <span aria-hidden="true">·</span>
    </>}
    {move.kind === "failed" && move.retry && !retrying && <>
      <button type="button" data-cloud-send-retry className="font-medium text-accent-text underline underline-offset-2 hover:text-ink" onClick={retry}>{t("cloudSend.strip.retry")}</button>
      <span aria-hidden="true">·</span>
    </>}
    {move.kind === "done" && <button type="button" className="hover:text-ink" onClick={close}>{t("cloudSend.strip.close")}</button>}
  </div>;
}
