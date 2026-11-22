import { useEffect, useState } from "react";
import { FolderGit2, KeyRound, PenLine } from "lucide-react";

import type { ProfileBotView } from "../../../shared/profile-plan";
import { onEduSettingsChanged } from "@/lib/edu-brain";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api } from "@/state/api";
import type { Bot } from "@/state/store";

const FIELD_LABEL: Record<string, LocaleKey> = {
  name: "profiles.field.name", title: "profiles.field.title", description: "profiles.field.description", soul: "profiles.field.soul",
  model: "profiles.field.model", effort: "profiles.field.effort", approval: "profiles.field.approval", tools: "profiles.field.tools",
  toolsOff: "profiles.field.toolsOff", mcpServers: "profiles.field.mcpServers", connectors: "profiles.field.connectors",
  eduBrain: "profiles.field.eduBrain", eduCrew: "profiles.field.eduCrew", "memory.enabled": "profiles.field.memory", "memory.upkeep": "profiles.field.memoryUpkeep",
  chief: "profiles.field.chief",
};

const fieldLabel = (field: string) => (FIELD_LABEL[field] ? t(FIELD_LABEL[field]) : field);

/** What a bot's own settings change, as one string: the view is read again after the person edits one of them. Its Edu
 * brain and crew are not on `Bot`; their change is heard from `onEduSettingsChanged`. */
const settingsKey = (bot: Bot) => JSON.stringify([
  bot.name, bot.title, bot.description, bot.soul, bot.approvalMode, bot.modelSelection, bot.toolScope, bot.toolsOff, bot.mcpServers,
  bot.connectorTools, bot.memoryEnabled, bot.memoryUpkeep, bot.chiefOfStaff, bot.profileSource?.appliedAt,
]);

/** Which fields were changed here and which keys the bot needs; null for a bot not from a profile, or when this person
 * may not read profiles. */
export function useProfileBotView(bot: Bot): ProfileBotView | null {
  const [view, setView] = useState<ProfileBotView | null>(null);
  const from = Boolean(bot.profileSource);
  const key = from ? settingsKey(bot) : "";
  const [eduChanges, setEduChanges] = useState(0);
  useEffect(() => onEduSettingsChanged((botId) => { if (botId === bot.id) setEduChanges((count) => count + 1); }), [bot.id]);
  useEffect(() => {
    if (!from) {
      setView(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<ProfileBotView>(`/api/profiles/bots/${encodeURIComponent(bot.id)}`)
        .then((next) => { if (!cancelled) setView(Array.isArray(next?.changedHere) && Array.isArray(next.secrets) ? next : null); })
        .catch(() => { if (!cancelled) setView(null); });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bot.id, from, key, eduChanges]);
  return view;
}

/** "From profile bi/analyst", what was changed here since, and each key the bot's profile asks this person for. */
export function ProfileBotBadge({ bot, view }: { bot: Bot; view: ProfileBotView | null }) {
  const source = bot.profileSource;
  if (!source) return null;
  const changed = view?.changedHere ?? [];
  const secrets = view?.secrets ?? [];
  return <div data-profile-badge="" className="flex flex-col gap-1.5 rounded-lg bg-inset px-3 py-2 text-[12px] leading-4 text-ink-secondary">
    <div className="flex min-w-0 items-center gap-1.5" title={source.file}>
      <FolderGit2 size={14} aria-hidden="true" className="shrink-0" />
      <span data-profile-from="" className="truncate">{t("profiles.bot.from", { id: `${source.area}/${source.key}` })}</span>
    </div>
    {changed.length > 0 && <div data-profile-changed="" className="flex min-w-0 items-start gap-1.5">
      <PenLine size={14} aria-hidden="true" className="mt-px shrink-0" />
      <span>{t("profiles.bot.changed", { fields: changed.map(fieldLabel).join(", ") })}</span>
    </div>}
    {secrets.map((secret) => <div key={secret.kind === "file" ? `file:${secret.for}` : `${secret.kind}:${secret.name}`}
      data-profile-secret={secret.kind === "file" ? "" : secret.name} data-profile-secret-kind={secret.kind} className="flex min-w-0 items-start gap-1.5">
      <KeyRound size={14} aria-hidden="true" className="mt-px shrink-0" />
      <span className="flex min-w-0 flex-1 flex-wrap gap-x-1.5">
        <span className="[overflow-wrap:anywhere]">{secret.kind === "file" ? t("profiles.bot.needsFile")
          : <><span dir="ltr" className="font-mono">{secret.name}</span>{" · "}{t("profiles.bot.needsKey")}</>}</span>
        <span className="ms-auto text-ink-tertiary">{t("profiles.bot.keyFor", { use: secret.for })}</span>
      </span>
    </div>)}
  </div>;
}

/** A small "Changed here" next to a field's title, when that field no longer has the profile's value. */
export function DriftMark({ view, field }: { view: ProfileBotView | null; field: string }) {
  if (!view?.changedHere.includes(field)) return null;
  return <span data-profile-drift={field} title={t("profiles.bot.driftHint")}
    className="ms-1.5 inline-flex h-4 shrink-0 items-center rounded-full bg-ink/[0.06] px-1.5 align-middle text-[11px] font-medium leading-4 text-ink-secondary">
    {t("profiles.bot.drift")}
  </span>;
}
