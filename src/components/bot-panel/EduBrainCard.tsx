import { useCallback, useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { decideEduProposal, fetchEduBrain, setEduCrew, turnOnEduBrain } from "@/lib/edu-brain";
import { eduProposalFields, eduProposalPlace } from "@/lib/edu-proposal-words";
import { EduProposalLines } from "../EduProposalLines";
import type { Bot } from "@/state/store";
import type { EduBrainView, EduProposal } from "../../../shared/edu-brain";
import { buttonCls, Card, ColRow, ItemRow, NoteRow, SwitchRow } from "./rows";

/** What the Edu brain row says, what to do when Edu can't serve this bot, and Edu's own reason when it gave one. */
export function eduStatusWords(view: Pick<EduBrainView, "state" | "mode" | "version" | "reason" | "brokenFolder" | "crewWorker" | "cloud">): { value: string; hint?: string; detail?: string; warn?: boolean } {
  if (view.mode === "off") return { value: t("eduBrain.state.botOff"), hint: t("eduBrain.state.botOffHint") };
  if (view.mode === "cloud" && view.cloud?.tokenMissing) return { value: t("eduBrain.cloud.needsKey"), hint: t("eduBrain.cloud.needsKeyHint", { name: view.cloud.token }), warn: true };
  switch (view.state) {
    case "ready": return {
      value: view.version ? t("eduBrain.state.readyVersion", { version: view.version }) : t("eduBrain.state.ready"),
      ...(view.crewWorker ? { hint: t("eduBrain.state.crewWorkerHint"), warn: true } : {}),
    };
    case "off": return { value: t("eduBrain.state.appOff"), hint: t("eduBrain.state.appOffHint") };
    case "missing": return { value: t("eduBrain.state.missing"), hint: t("eduBrain.state.missingHint"), warn: true };
    case "old": return { value: t("eduBrain.state.old", { version: view.version ?? "?" }), hint: t("eduBrain.state.oldHint"), warn: true };
    case "broken": return {
      value: t("eduBrain.state.broken"), hint: t(view.brokenFolder ? "eduBrain.state.folderHint" : "eduBrain.state.brokenHint"), warn: true,
      ...(view.reason ? { detail: view.reason } : {}),
    };
  }
}

function PathValue({ path }: { path: string }) {
  return <span dir="ltr" title={path} className="block truncate font-mono text-[12px] text-ink-secondary">{path}</span>;
}

/** Bot settings, Memory: this bot's Edu brain and the canonical notes waiting for the person, wherever they were
 * proposed. */
function ProposalFields({ proposal }: { proposal: EduProposal }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" aria-expanded={open} data-edu-details onClick={() => setOpen((value) => !value)}
        className="mt-1 text-[13px] text-ink-secondary hover:text-ink">
        {open ? t("approval.applied.hideDetails") : t("approval.applied.details")}
      </button>
      {open && (
        <pre dir="ltr" tabIndex={0} className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 font-mono text-[12px] leading-[18px] text-ink-secondary">
          {eduProposalFields(proposal)}
        </pre>
      )}
    </>
  );
}

export function EduBrainCard({ bot }: { bot: Pick<Bot, "id" | "name" | "busy"> & Partial<Pick<Bot, "color">> }) {
  const [view, setView] = useState<EduBrainView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async (afterAction = false) => {
    try {
      setView(await fetchEduBrain(bot.id));
      if (!afterAction) setFailed(null);
    } catch (error) {
      setFailed(error instanceof Error && error.message ? error.message : t("eduBrain.loadFailed"));
    }
  }, [bot.id]);
  useEffect(() => { void load(); }, [load, bot.busy]);

  const decide = async (proposal: EduProposal, action: "approve" | "reject") => {
    if (busy) return;
    setBusy(`${action}:${proposal.id}`);
    try {
      await decideEduProposal(bot.id, proposal.id, action);
      setFailed(null);
    } catch (error) {
      setFailed(error instanceof Error && error.message ? error.message : t("eduBrain.decideFailed"));
    } finally {
      setBusy(null);
      await load(true);
    }
  };

  const turnOn = async () => {
    if (busy) return;
    setBusy("turn-on");
    try {
      await turnOnEduBrain(bot.id);
      setFailed(null);
    } catch (error) {
      setFailed(error instanceof Error && error.message ? error.message : t("eduBrain.turnOnFailed"));
    } finally {
      setBusy(null);
      await load(true);
    }
  };

  const toggleCrew = async () => {
    if (busy || !view?.crew) return;
    setBusy("crew");
    try {
      await setEduCrew(bot.id, !view.crew.enabled);
      setFailed(null);
    } catch (error) {
      setFailed(error instanceof Error && error.message ? error.message : t("eduBrain.crew.failed"));
    } finally {
      setBusy(null);
      await load(true);
    }
  };

  const status = view ? eduStatusWords(view) : null;
  const ready = view?.state === "ready" && view.mode !== "off";
  const cloudReadOnly = Boolean(view?.cloud && (!view.cloud.review || view.cloud.scope !== "steward"));
  return (
    <>
      <Card label={t("eduBrain.section")} anchor="edu-brain">
        {!view ? (
          <NoteRow tone={failed ? "warn" : undefined}>{failed ?? t("common.checking")}</NoteRow>
        ) : (
          <>
            <ItemRow data-panel-row="edu-status" title={t("eduBrain.status")} hint={status?.hint && (
              <>
                <span className={status.warn ? "text-warning" : undefined}>{status.hint}</span>
                {status.detail && <span data-edu-reason className="mt-0.5 block break-words text-[12px] text-ink-secondary">{status.detail}</span>}
              </>
            )}>
              <span className="shrink-0 text-[13px] text-ink-secondary">{status?.value}</span>
              {view.mode === "off" && (
                <button type="button" data-edu-action="turn-on" className={buttonCls} disabled={busy !== null} onClick={() => void turnOn()}>
                  {t("eduBrain.turnOn")}
                </button>
              )}
            </ItemRow>
            {view.brokenFolder && view.brain && <ItemRow data-panel-row="edu-folder" title={t("eduBrain.folder")} hint={<PathValue path={view.brain} />} />}
            {ready && view.brain && view.mode !== "cloud" && <ItemRow data-panel-row="edu-folder" title={t("eduBrain.folder")} hint={<PathValue path={view.brain} />} />}
            {view.cloud && <ItemRow data-panel-row="edu-cloud" title={t("eduBrain.cloud.title")} hint={<PathValue path={view.cloud.url} />} />}
            {view.cloud?.label && (
              <ItemRow data-panel-row="edu-cloud-token" title={t("eduBrain.cloud.token")}
                hint={t(view.cloud.scope === "steward" ? "eduBrain.cloud.steward" : "eduBrain.cloud.member", { label: view.cloud.label })} />
            )}
            {view.cloud?.error && <NoteRow tone="warn">{t("eduBrain.cloud.unreachable", { reason: view.cloud.error })}</NoteRow>}
            {ready && view.home && <ItemRow data-panel-row="edu-home" title={t("eduBrain.global")} hint={<PathValue path={view.home} />} />}
            {ready && view.personalBrain === false && <ItemRow data-panel-row="edu-home" title={t("eduBrain.global")} hint={t("eduBrain.personalOff")} />}
            {view.crew && (ready || view.crew.enabled) && (
              <SwitchRow data-panel-row="edu-crew" title={t("eduBrain.crew.title")} checked={view.crew.enabled} color={bot.color ?? "blue"}
                disabled={busy !== null} onChange={() => void toggleCrew()}
                hint={view.crew.blocked ? <span className="text-warning">{view.crew.blocked}</span>
                  : view.crew.folder ? t("eduBrain.crew.folder", { folder: view.crew.folder }) : t("eduBrain.crew.hint")} />
            )}
            {failed && !ready && <NoteRow tone="warn">{failed}</NoteRow>}
          </>
        )}
      </Card>
      {view && ready && (
        <Card label={t("eduBrain.proposals")} anchor="edu-proposals">
          {view.crewWorker && <NoteRow tone="warn">{t("eduBrain.crewWorker")}</NoteRow>}
          {cloudReadOnly && <NoteRow>{t(view.cloud?.review ? "eduBrain.cloud.stewardOnly" : "eduBrain.cloud.approveOnServer")}</NoteRow>}
          {!cloudReadOnly && !view.crewWorker && !view.mayApprove && view.proposals.length > 0 && <NoteRow>{t("eduBrain.approveElsewhere")}</NoteRow>}
          {view.listError && <NoteRow tone="warn">{t("eduBrain.listFailed", { reason: view.listError })}</NoteRow>}
          {!view.listError && view.proposals.length === 0 && view.cloud?.review !== false && <NoteRow>{t("eduBrain.noProposals")}</NoteRow>}
          {view.proposals.map((proposal) => (
            <ColRow key={`${proposal.global ? "g" : "b"}:${proposal.id}`} data-panel-row="edu-proposal">
              <div className="min-w-0">
                <EduProposalLines proposal={proposal} place={eduProposalPlace(proposal, bot.name)} titleClassName="mt-0 text-[14px] leading-5" />
                <ProposalFields proposal={proposal} />
              </div>
              {!cloudReadOnly && <div className="flex flex-wrap justify-end gap-2">
                <button type="button" data-edu-action="reject" className={buttonCls} disabled={busy !== null || view.crewWorker || (Boolean(view.cloud) && !view.mayApprove)}
                  onClick={() => void decide(proposal, "reject")}>
                  {busy === `reject:${proposal.id}` ? t("eduBrain.action.rejecting") : t("server.edu.reject")}
                </button>
                <button type="button" data-edu-action="approve" className={buttonCls} disabled={busy !== null || !view.mayApprove}
                  onClick={() => void decide(proposal, "approve")}>
                  {busy === `approve:${proposal.id}` ? t("eduBrain.action.approving") : t("server.edu.approve")}
                </button>
              </div>}
            </ColRow>
          ))}
          {failed && <NoteRow tone="warn">{failed}</NoteRow>}
        </Card>
      )}
    </>
  );
}
