import { useEffect, useState } from "react";

import { api } from "@/state/store";
import type { EduBrainView, EduDecideRights } from "../../shared/edu-brain";

export function fetchEduBrain(botId: string): Promise<EduBrainView> {
  return api<EduBrainView>(`/api/bots/${encodeURIComponent(botId)}/edu`);
}

export function decideEduProposal(botId: string, id: string, action: "approve" | "reject"): Promise<{ ok: true; outcome: string }> {
  return api(`/api/bots/${encodeURIComponent(botId)}/edu/proposals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action }) });
}

let known: EduDecideRights | null = null;
let asking: Promise<EduDecideRights | null> | null = null;

function askRights(): Promise<EduDecideRights | null> {
  asking ??= api<EduDecideRights>("/api/edu/rights").then((rights) => { known = rights; return rights; }, () => null)
    .finally(() => { asking = null; });
  return asking;
}

/** What the server lets this person decide on an Edu proposal; null while it is asked. When it can't be asked, both
 * answers stay offered and the server refuses what it must. */
export function useEduRights(): EduDecideRights | null {
  const [rights, setRights] = useState<EduDecideRights | null>(known);
  useEffect(() => {
    let live = true;
    if (!known) void askRights().then((answer) => { if (live) setRights(answer ?? { mayApprove: true, mayReject: true }); });
    return () => { live = false; };
  }, []);
  return rights;
}
