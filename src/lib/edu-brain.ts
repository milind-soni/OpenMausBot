import { useEffect, useState } from "react";

import { api } from "@/state/store";
import type { EduBrainView, EduDecideRights } from "../../shared/edu-brain";

export function fetchEduBrain(botId: string): Promise<EduBrainView> {
  return api<EduBrainView>(`/api/bots/${encodeURIComponent(botId)}/edu`);
}

export function decideEduProposal(botId: string, id: string, action: "approve" | "reject"): Promise<{ ok: true; outcome: string }> {
  return api(`/api/bots/${encodeURIComponent(botId)}/edu/proposals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action }) });
}

const eduChanges = new EventTarget();

const patchEdu = async (botId: string, patch: { eduBrain: { mode: "own" } } | { eduCrew: boolean }) => {
  const answer = await api(`/api/bots/${encodeURIComponent(botId)}`, { method: "PATCH", body: JSON.stringify(patch) });
  eduChanges.dispatchEvent(new CustomEvent<string>("change", { detail: botId }));
  return answer;
};

/** Calls `listener` with the bot's id after this page changed that bot's Edu brain or Edu crew; returns the unsubscribe. */
export function onEduSettingsChanged(listener: (botId: string) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<string>).detail);
  eduChanges.addEventListener("change", handle);
  return () => eduChanges.removeEventListener("change", handle);
}

/** Gives a bot whose Edu brain is off its own brain again. The server refuses this from a bot's shell. */
export function turnOnEduBrain(botId: string): Promise<unknown> {
  return patchEdu(botId, { eduBrain: { mode: "own" } });
}

/** Turns a bot's Edu crew on or off. The server refuses turning it on from a bot's shell. */
export function setEduCrew(botId: string, on: boolean): Promise<unknown> {
  return patchEdu(botId, { eduCrew: on });
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
