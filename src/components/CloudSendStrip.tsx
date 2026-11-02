import { useEffect, useState } from "react";
import type { CloudSendNotice, CloudSendPageBridge } from "../../electron/cloud-send.mjs";
import { moveQuietUntil } from "@/lib/cloud-send";
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

/** In the desktop app, never in a browser: on My Cloud's page, a bot's move into a team. The one-time move to My Cloud is
 * never a strip over the page: it lives in the account area at the bottom of the sidebar (AccountMove). */
export function CloudSendStrip({ cloudHome }: { cloudHome: boolean }) {
  const bridge = !window.ogb?.remoteClient?.active ? window.ogb?.cloudSendPage : undefined;
  const [notice, setNotice] = useCloudSendNotice(bridge);
  if (!bridge || !cloudHome || !notice?.teamMove) return null;
  return <TeamMoveLine move={notice.teamMove} onChange={(next) => setNotice({ ...notice, teamMove: next ?? undefined })} />;
}
