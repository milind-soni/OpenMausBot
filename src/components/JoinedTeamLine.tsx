import { useState } from "react";
import { Users, X } from "lucide-react";
import { brandStatus } from "@/lib/brand";
import type { CloudSource } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { dismissNotice, JOINED_TEAM_LINE, noticeSeen } from "@/lib/notices";
import { api, useStore } from "@/state/store";
import { useCloudPlan } from "./ProIntroduction";

/** Nobody is signed in on this desktop, on its own page: null-safe everywhere else (a browser, a Cloud's page, a branded build). */
export function useSignedOutHere(): boolean {
  const kind = useCloudPlan()?.view.kind;
  return (kind === "signed-out" || kind === "removed") && brandStatus().source !== "file";
}

/** What someone who accepted a team's invite in a browser needs next, and the sign-in itself. */
export function JoinedTeamSignIn({ source }: { source: CloudSource }) {
  const { dispatch } = useStore();
  return <>
    <span dir="auto">{t("homeLine.joinedTeam")}</span>{" "}
    <button type="button" data-joined-team-sign-in className="font-medium text-ink underline underline-offset-2"
      onClick={() => dispatch({ type: "openCloudAdd", source, signIn: true })}>{t("cloudAccount.signInShort")}</button>
  </>;
}

/** The window's one line while nobody is signed in and main has no other to say. It stays until signing in, or until the person
 * closes it: most people signed out here have no team and never will. */
export function JoinedTeamLine() {
  const { state, dispatch } = useStore();
  const signedOut = useSignedOutHere();
  const [closed, setClosed] = useState(false);
  const record = state.config?.onboarding;
  if (!signedOut || closed || noticeSeen(record, JOINED_TEAM_LINE)) return null;
  const close = () => {
    setClosed(true);
    const patch = dismissNotice(record, JOINED_TEAM_LINE);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) }).then((config) => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  return <div role="status" data-home-line="joined-team" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
    <Users size={14} aria-hidden="true" />
    <span><JoinedTeamSignIn source="app_menu" /></span>
    <button type="button" data-joined-team-close aria-label={t("cloudAdd.close")} title={t("cloudAdd.close")} className="rounded hover:text-ink" onClick={close}><X size={14} aria-hidden="true" /></button>
  </div>;
}
