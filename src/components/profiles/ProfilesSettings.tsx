import { useCallback, useEffect, useRef, useState } from "react";

import type { ProfileApplyResult, ProfileChoice, ProfilePlan, ProfilePlanLine, ProfilesStatus } from "../../../shared/profile-plan";
import { pageIsThisComputer } from "@/lib/companion-bridge";
import { intlLocale, t } from "@/lib/i18n";
import {
  accessNames, botsUpdated, folderIsEmpty, onlyAccessLeft, openConflicts, planGroups, planHasWork, type PlanGroup, type PlanGroupId,
} from "@/lib/profile-plan-view";
import type { LocaleKey } from "@/locales";
import { api, ApiError } from "@/state/api";
import { SettingsSkeletonCard } from "../settings/SettingsStates";
import {
  LearnMore, Segmented, SettingRow, SettingsEmptyRow, SettingsFormFoot, SettingsGroup, SettingsRows, Switch, SETTINGS_INPUT,
} from "../SettingsPrimitives";

export const PROFILES_DOCS_URL = "https://github.com/EduardoMoraga/edu-bot/blob/main/docs/profiles.md";

const GROUP_LABEL: Record<PlanGroupId, LocaleKey> = {
  problems: "profiles.group.problems", add: "profiles.group.add", change: "profiles.group.change", access: "profiles.group.access",
  changedHere: "profiles.group.changedHere", conflict: "profiles.group.conflict", gone: "profiles.group.gone", later: "profiles.group.later",
  notes: "profiles.group.notes",
};

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const asSentence = (text: string) => {
  const trimmed = text.trim();
  return trimmed ? `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? "" : "."}` : trimmed;
};
const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : t("profiles.error.unknown"));

type Outcome =
  | { kind: "applied"; result: ProfileApplyResult }
  | { kind: "refused"; message: string }
  | { kind: "stale" }
  | { kind: "failed"; message: string };

/** Settings → Profiles: the profile folder, what applying it would do, and Apply. */
export function ProfilesSettings() {
  const [status, setStatus] = useState<ProfilesStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ProfilePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [choices, setChoices] = useState<Record<string, ProfileChoice>>({});
  const [settled, setSettled] = useState<Map<string, ProfilePlanLine>>(new Map());
  const [giveAccess, setGiveAccess] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const generation = useRef(0);

  const loadPlan = useCallback(async (nextChoices: Record<string, ProfileChoice>) => {
    const current = ++generation.current;
    setPlanning(true);
    setPlanError(null);
    try {
      const next = await api<ProfilePlan>("/api/profiles/plan", post({ choices: nextChoices }));
      if (current === generation.current) setPlan(next);
    } catch (error) {
      if (current === generation.current) setPlanError(errorText(error));
    } finally {
      if (current === generation.current) setPlanning(false);
    }
  }, []);

  const startOver = useCallback((folder: string | undefined) => {
    setChoices({});
    setSettled(new Map());
    setGiveAccess(false);
    setConfirming(false);
    if (folder) void loadPlan({});
    else setPlan(null);
  }, [loadPlan]);

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const next = await api<ProfilesStatus>("/api/profiles");
      setStatus(next);
      return next;
    } catch (error) {
      setStatusError(errorText(error));
      return null;
    }
  }, []);

  useEffect(() => {
    void loadStatus().then((next) => { if (next?.folder) void loadPlan({}); });
    return () => { generation.current++; };
  }, [loadStatus, loadPlan]);

  const chooseFolder = async (folder: string) => {
    const next = await api<ProfilesStatus>("/api/profiles/folder", { method: "PUT", body: JSON.stringify({ folder }) });
    setStatus(next);
    setOutcome(null);
    startOver(next.folder);
  };

  const choose = (line: ProfilePlanLine, choice: ProfileChoice) => {
    if (!line.conflict) return;
    const next = { ...choices, [line.conflict.choice]: choice };
    setChoices(next);
    setSettled(new Map(settled).set(line.conflict.choice, line));
    setConfirming(false);
    void loadPlan(next);
  };

  const apply = async (withAccess: boolean) => {
    if (!plan) return;
    setConfirming(false);
    setApplying(true);
    setOutcome(null);
    try {
      const result = await api<ProfileApplyResult>("/api/profiles/apply", post({ choices, giveAccess: withAccess, expect: plan.digest }));
      setOutcome({ kind: "applied", result });
      void loadStatus();
      startOver(result.folder);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.body?.plan) {
        setPlan(error.body.plan as ProfilePlan);
        setOutcome({ kind: "stale" });
      } else if (error instanceof ApiError && error.status === 403) {
        if (withAccess) setGiveAccess(false);
        setOutcome({ kind: "refused", message: errorText(error) });
      } else {
        setOutcome({ kind: "failed", message: errorText(error) });
      }
    } finally {
      setApplying(false);
    }
  };

  if (statusError && !status) {
    return <SettingsGroup label={t("profiles.folder.section")} block="folder">
      <ErrorRow message={t("profiles.error.status", { error: statusError })} onRetry={() => void loadStatus()} />
    </SettingsGroup>;
  }
  if (!status) return <SettingsSkeletonCard place={t("settings.page.profiles")} />;

  const groups = plan ? planGroups(plan, settled) : [];
  const hasAccess = Boolean(plan?.lines.some((line) => line.kind === "access"));
  const waiting = plan ? openConflicts(plan, choices).length : 0;
  const work = plan ? planHasWork(plan, choices) : false;
  const empty = plan ? folderIsEmpty(plan) : false;
  const accessOnly = plan ? onlyAccessLeft(plan, choices) : false;
  const refused = outcome?.kind === "refused" && hasAccess && !giveAccess;
  const canApply = work && !(accessOnly && !giveAccess);

  return <div className="flex flex-col gap-6" data-profiles="">
    <FolderSection status={status} onChoose={chooseFolder} />

    {!status.folder && <p data-profiles-empty="" className="px-4 text-[13px] leading-[18px] text-ink-secondary">
      {t("profiles.empty")}{" "}<LearnMore href={PROFILES_DOCS_URL} label={t("profiles.learn")} />
    </p>}

    {status.folder && <SettingsGroup label={t("profiles.plan.section")} block="plan"
      actions={plan && !planning ? <button type="button" className="ui-button ui-button-sm rounded-full" onClick={() => void loadPlan(choices)}>{t("profiles.plan.check")}</button> : undefined}>
      {planError && <ErrorRow message={t("profiles.error.plan", { error: planError })} onRetry={() => void loadPlan(choices)} />}
      {!planError && !plan && <SettingsSkeletonCard place={t("settings.page.profiles")} />}
      {!planError && plan && empty && <SettingsRows><div data-profiles-empty="" className="px-4 py-3 text-[13px] leading-[18px] text-ink-secondary">
        {t("profiles.empty")}{" "}<LearnMore href={PROFILES_DOCS_URL} label={t("profiles.learn")} />
      </div></SettingsRows>}
      {!planError && plan && !empty && plan.noChanges && groups.length === 0 && <SettingsRows><SettingsEmptyRow>{t("profiles.plan.none")}</SettingsEmptyRow></SettingsRows>}
    </SettingsGroup>}

    {plan && !planError && !empty && groups.map((group) => <PlanGroupView key={group.id} group={group} choices={choices} onChoose={choose}
      giveAccess={giveAccess} onGiveAccess={(on) => { setGiveAccess(on); setConfirming(false); }} disabled={planning || applying} />)}

    {plan && !planError && !empty && (work || outcome) && <div data-profiles-apply="">
      <SettingsRows>
        {confirming && <AccessConfirm names={accessNames(plan)} lines={plan.lines.filter((line) => line.kind === "access").map((line) => line.text)} onConfirm={() => void apply(true)} onCancel={() => setConfirming(false)} />}
        {!confirming && <SettingsFormFoot status={<OutcomeLine outcome={outcome} waiting={waiting} work={work} accessOnly={accessOnly} giveAccess={giveAccess} />}>
          {canApply && (refused
            ? <button type="button" data-profiles-action="apply-without" className="ui-button ui-button-md ui-button-primary rounded-full" disabled={planning || applying}
              onClick={() => { setGiveAccess(false); void apply(false); }}>{applying ? t("profiles.applying") : t("profiles.refused.without")}</button>
            : <button type="button" data-profiles-action="apply" className="ui-button ui-button-md ui-button-primary rounded-full" disabled={planning || applying}
              onClick={() => (giveAccess && hasAccess ? setConfirming(true) : void apply(false))}>{applying ? t("profiles.applying") : t("profiles.apply")}</button>)}
        </SettingsFormFoot>}
      </SettingsRows>
    </div>}
  </div>;
}

function FolderSection({ status, onChoose }: { status: ProfilesStatus; onChoose: (folder: string) => Promise<void> }) {
  const pick = window.ogb?.remoteClient?.active || !pageIsThisComputer() ? undefined : window.ogb?.pickFolder;
  const [typed, setTyped] = useState("");
  const [editing, setEditing] = useState(!status.folder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const use = async (folder: string | null | undefined) => {
    if (!folder?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onChoose(folder.trim());
      setTyped("");
      setEditing(false);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const applied = status.applied;
  const when = applied ? new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(applied.at)) : null;
  return <SettingsGroup label={t("profiles.folder.section")} block="folder">
    <SettingsRows>
      <SettingRow title={t("profiles.folder.title")}
        subtitle={status.folder ? <span data-profiles-folder="" dir="ltr" title={status.folder} className="block truncate font-mono text-[12px]">{status.folder}</span> : t("profiles.folder.none")}
        message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
        {pick && <button type="button" data-profiles-action="pick" className="ui-button ui-button-sm rounded-full" disabled={busy}
          onClick={() => void pick(status.folder).then(use).catch((failure: unknown) => setError(errorText(failure)))}>
          {status.folder ? t("profiles.folder.change") : t("profiles.folder.choose")}
        </button>}
        {!pick && !editing && <button type="button" data-profiles-action="change-path" className="ui-button ui-button-sm rounded-full"
          onClick={() => setEditing(true)}>{t("profiles.folder.change")}</button>}
      </SettingRow>
      {!pick && editing && <form className="flex flex-col gap-2 px-4 py-3" onSubmit={(event) => { event.preventDefault(); void use(typed); }}>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium leading-[18px] text-ink">{t("profiles.folder.pathLabel")}</span>
          <input data-profiles-path="" dir="ltr" value={typed} onChange={(event) => setTyped(event.target.value)} className={`${SETTINGS_INPUT} font-mono`}
            spellCheck={false} autoComplete="off" />
        </label>
        <span className="text-[12px] leading-4 text-ink-secondary">{t("profiles.folder.pathHint")}</span>
        <div className="flex justify-end">
          <button type="submit" data-profiles-action="use-path" className="ui-button ui-button-sm rounded-full" disabled={busy || !typed.trim()}>{t("profiles.folder.use")}</button>
        </div>
      </form>}
      {status.folder && <SettingRow title={t("profiles.applied.title")}
        subtitle={<span data-profiles-applied="" className="tabular-nums">{applied && when
          ? (applied.commit ? t("profiles.applied.withCommit", { date: when, commit: applied.commit.slice(0, 7) }) : when)
          : t("profiles.applied.never")}</span>}>{null}</SettingRow>}
    </SettingsRows>
  </SettingsGroup>;
}

function PlanGroupView({ group, choices, onChoose, giveAccess, onGiveAccess, disabled }: {
  group: PlanGroup;
  choices: Record<string, ProfileChoice>;
  onChoose: (line: ProfilePlanLine, choice: ProfileChoice) => void;
  giveAccess: boolean;
  onGiveAccess: (on: boolean) => void;
  disabled: boolean;
}) {
  const description = group.id === "access" ? t("profiles.access.hint") : group.id === "conflict" ? t("profiles.conflict.hint") : undefined;
  return <SettingsGroup label={t(GROUP_LABEL[group.id])} block={`plan-${group.id}`} description={description}>
    <SettingsRows>
      {group.sentences.map((sentence) => <PlanText key={sentence} kind={group.id} text={sentence} />)}
      {group.lines.map((line, index) => line.kind === "conflict" && line.conflict
        ? <ConflictRow key={line.conflict.choice} line={line} choice={choices[line.conflict.choice]} onChoose={onChoose} disabled={disabled} />
        : <PlanText key={`${line.subject.id}:${line.field ?? ""}:${index}`} kind={line.kind} text={line.text} file={line.file} />)}
      {group.id === "access" && <SettingRow title={t("profiles.access.allow")}>
        <Switch data-profiles-action="allow-access" aria-label={t("profiles.access.allow")} checked={giveAccess} disabled={disabled} onClick={() => onGiveAccess(!giveAccess)} />
      </SettingRow>}
    </SettingsRows>
  </SettingsGroup>;
}

function PlanText({ kind, text, file }: { kind: string; text: string; file?: string }) {
  return <div data-plan-line={kind} title={file} dir="auto" className="px-4 py-2.5 text-[13px] leading-[18px] text-ink [overflow-wrap:anywhere]">{text}</div>;
}

function ConflictRow({ line, choice, onChoose, disabled }: {
  line: ProfilePlanLine;
  choice: ProfileChoice | undefined;
  onChoose: (line: ProfilePlanLine, choice: ProfileChoice) => void;
  disabled: boolean;
}) {
  return <div data-plan-line="conflict" data-conflict={line.conflict!.choice} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
    <div className="flex min-w-[min(100%,12rem)] flex-1 flex-col gap-0.5">
      <span dir="auto" className="text-[13px] leading-[18px] text-ink [overflow-wrap:anywhere]">{line.text}</span>
      <span dir="auto" className="text-[12px] leading-4 text-ink-secondary [overflow-wrap:anywhere]">
        {t("profiles.conflict.values", { file: line.conflict!.file, mine: line.conflict!.mine })}
      </span>
    </div>
    <Segmented<ProfileChoice | ""> label={line.text} value={choice ?? ""} disabled={disabled} onChange={(value) => { if (value) onChoose(line, value); }}
      options={[{ value: "mine", label: t("profiles.conflict.mine") }, { value: "file", label: t("profiles.conflict.file") }]} />
  </div>;
}

function AccessConfirm({ names, lines, onConfirm, onCancel }: { names: string[]; lines: string[]; onConfirm: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return <div role="group" aria-labelledby="profiles-confirm-title" data-profiles-confirm="" className="flex flex-col gap-3 px-4 py-3"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }}>
    <div className="flex flex-col gap-0.5">
      <span id="profiles-confirm-title" className="text-[14px] font-medium leading-5 text-ink">{t("profiles.confirm.title")}</span>
      <span dir="auto" className="text-[13px] leading-[18px] text-ink-secondary">{t("profiles.confirm.body", { names: names.join(", ") })}</span>
    </div>
    <ul className="flex list-disc flex-col gap-1 ps-5 text-[13px] leading-[18px] text-ink">
      {lines.map((text, index) => <li key={index} dir="auto" data-profiles-confirm-line="">{text}</li>)}
    </ul>
    <div className="flex flex-wrap justify-end gap-2">
      <button ref={cancel} type="button" data-profiles-action="cancel-access"
        className="ui-button ui-button-md rounded-full focus:outline-2 focus:outline-offset-2 focus:outline-focus" onClick={onCancel}>{t("profiles.confirm.cancel")}</button>
      <button type="button" data-profiles-action="confirm-access" className="ui-button ui-button-md ui-button-primary rounded-full" onClick={onConfirm}>{t("profiles.confirm.yes")}</button>
    </div>
  </div>;
}

function OutcomeLine({ outcome, waiting, work, accessOnly, giveAccess }: {
  outcome: Outcome | null;
  waiting: number;
  work: boolean;
  accessOnly: boolean;
  giveAccess: boolean;
}) {
  const turnOn = accessOnly && !giveAccess && outcome?.kind !== "refused"
    ? <span data-profiles-access-only="">{t("profiles.access.turnOn")}</span> : null;
  if (outcome?.kind === "applied") {
    const count = botsUpdated(outcome.result);
    const { lines, skipped } = outcome.result.applied;
    const summary = count === 1 ? t("profiles.result.botsOne") : count > 1 ? t("profiles.result.botsMany", { count })
      : lines.length === 0 && skipped.length > 0 ? t("profiles.result.nothing") : t("profiles.result.none");
    return <span role="status" data-profiles-result="" className="flex flex-col gap-1">
      <span className="text-ink">{summary}</span>
      {skipped.map((line, index) => <span key={index} dir="auto" data-profiles-skipped="">{t("profiles.result.skipped", { line: line.text, reason: asSentence(line.reason) })}</span>)}
      {turnOn}
    </span>;
  }
  if (outcome?.kind === "refused") {
    return <span role="alert" data-profiles-refused="" className="flex flex-col gap-1">
      <span className="text-ink">{outcome.message}</span>
      <span>{accessOnly ? t("profiles.refused.whatOnly") : t("profiles.refused.what")}</span>
    </span>;
  }
  if (outcome?.kind === "stale") return <span role="status" data-profiles-stale="">{t("profiles.stale")}</span>;
  if (outcome?.kind === "failed") return <span role="alert" className="text-danger">{t("profiles.error.apply", { error: outcome.message })}</span>;
  if (waiting && work) return <span>{waiting === 1 ? t("profiles.conflict.waitingOne") : t("profiles.conflict.waitingMany", { count: waiting })}</span>;
  return turnOn;
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <SettingsRows>
    <div role="alert" className="flex min-h-11 flex-wrap items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1 text-[13px] leading-[18px] text-ink">{message}</span>
      <button type="button" className="ui-button ui-button-sm rounded-full" onClick={onRetry}>{t("settings.state.tryAgain")}</button>
    </div>
  </SettingsRows>;
}
