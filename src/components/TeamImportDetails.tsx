// The template preview body: what a team, package or backup brings and what stays behind. Shared by Templates,
// the organization shelf and the Grok Bot import.
import { BookOpen, CalendarClock, Check, Crown, MessageSquare, NotebookPen, Plug, Users } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { PendingTeamImport } from "@/lib/team-import";

export const TEAM_GLYPHS = [
  "bg-purple-500/15 text-purple-300",
  "bg-cyan-500/15 text-cyan-300",
  "bg-orange-500/15 text-orange-300",
  "bg-emerald-500/15 text-emerald-300",
] as const;

export function TeamImportDetails({ pending, importedNames, org = false }: {
  pending: PendingTeamImport;
  importedNames: string[];
  org?: boolean;
}) {
  return (
    <>
      {pending.description && (
        <p className="max-w-2xl text-[14px] leading-relaxed text-ink-secondary">{pending.description}</p>
      )}
      {pending.brief && (
        <div className="mt-4 rounded-xl border border-hairline px-4 py-3 text-[13px] text-ink-secondary">
          <div className="font-medium text-ink">{t("teamImport.brief")}</div>
          <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words">{pending.brief}</p>
        </div>
      )}
      {Boolean(pending.warnings?.length) && <div className="mt-4 rounded-xl border border-hairline px-4 py-3 text-[13px] text-ink-secondary">
        <div className="mb-2 font-medium text-ink">{pending.leftOut ? t("grokImport.leftOut") : t("templates.backupNotes")}</div>
        {pending.warnings?.map((warning, index) => <p key={index}>{warning}</p>)}
      </div>}
      {(pending.kind === "package" || pending.kind === "backup") && (
        <div className="mt-5 flex flex-wrap gap-2 text-[12px] text-ink-secondary">
          {pending.chiefOfStaff && <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><Crown size={13} />{t("templates.leads", { name: pending.chiefOfStaff })}</span>}
          {!pending.library && <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><MessageSquare size={13} />{t("templates.groupChats", { count: pending.rooms })}</span>}
          {!(pending.library && !pending.playbooks) && <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><BookOpen size={13} />{t("templates.playbooks", { count: pending.playbooks })}</span>}
          {!pending.library && <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><CalendarClock size={13} />{pending.version === 2 ? t("teamImport.routinesPaused", { count: pending.routines }) : t("templates.pausedRoutines", { count: pending.routines })}</span>}
          {pending.kind === "package" && pending.version !== 2 && <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><Plug size={13} />{t("templates.connections", { count: pending.apps.length })}</span>}
          {Boolean(pending.connections?.length) && <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><Plug size={13} />{t("teamImport.connections", { count: pending.connections?.length ?? 0 })}</span>}
          {Boolean(pending.notes) && <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><NotebookPen size={13} />{t("teamImport.notes", { count: pending.notes ?? 0 })}</span>}
          {Boolean(pending.presets?.length) && <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><Users size={13} />{t("teamImport.presets", { count: pending.presets?.length ?? 0 })}</span>}
        </div>
      )}
      {Boolean(pending.skills?.length) && (
        <div className="mt-4 rounded-xl border border-hairline px-4 py-3 text-[13px] text-ink-secondary">
          <div className="font-medium text-ink">{org ? t("orgLibrary.skillsOn") : pending.version === 2 ? t("teamImport.skillsOff") : t("templates.skillsDisabled")}</div>
          <p className="mt-1 break-words">{pending.skills?.join(", ")}</p>
          {!org && <p className="mt-1">{pending.version === 2 ? t("teamImport.skillsReview") : t("templates.skillsReview")}</p>}
        </div>
      )}
      {pending.library && Boolean(pending.presets?.length) && (
        <div className="mt-4 rounded-xl border border-hairline px-4 py-3 text-[13px] text-ink-secondary">
          <div className="font-medium text-ink">{t("teamImport.presetList")}</div>
          <p className="mt-1 break-words">{pending.presets?.join(", ")}</p>
        </div>
      )}
      {Boolean(pending.offeredSkills?.length) && (
        <div className="mt-4 rounded-xl border border-hairline px-4 py-3 text-[13px] text-ink-secondary">
          <div className="font-medium text-ink">{t("teamImport.offeredSkills")}</div>
          <p className="mt-1 break-words">{pending.offeredSkills?.join(", ")}</p>
        </div>
      )}
      {Boolean(pending.connections?.length) && (
        <div className="mt-4 rounded-xl border border-hairline px-4 py-3 text-[13px] text-ink-secondary">
          <div className="font-medium text-ink">{t("teamImport.connections", { count: pending.connections?.length ?? 0 })}</div>
          <ul className="mt-1">
            {pending.connections?.map((connection, index) => (
              <li key={`${connection.label}-${index}`} className="truncate">{connection.label} · {connection.url}</li>
            ))}
          </ul>
        </div>
      )}
      {pending.members.length > 0 && <div className="mt-6 text-[12px] font-medium text-ink-secondary">{t("templates.teamMembers")}</div>}
      <div className="mt-2 grid grid-cols-1 gap-x-10 md:grid-cols-2">
        {pending.members.map((member, index) => (
          <div key={`${member.name}-${index}`} className="flex min-h-[72px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
            {pending.pictures?.[index]
              ? <img src={pending.pictures[index]!} alt="" className="size-9 shrink-0 rounded-lg object-cover" />
              : (
                <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold", TEAM_GLYPHS[index % TEAM_GLYPHS.length])}>
                  {member.name.slice(0, 1).toUpperCase()}
                </div>
              )}
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-ink">{importedNames[index]}</div>
              {importedNames[index] !== member.name && <div className="text-[12px] text-ink-secondary">{t("templates.newCopyOf", { name: member.name })}</div>}
              <div className="mt-0.5 truncate text-[13px] text-ink-secondary">{member.title || t("templates.generalAssistant")}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 flex items-start gap-2.5 rounded-xl bg-raised/45 px-4 py-3 text-[13px] leading-relaxed text-ink-secondary">
        <Check size={15} className="mt-0.5 shrink-0 text-success" />
        <p>
          {pending.kind === "backup"
            ? t("templates.backupSafety", { archived: pending.archivedBots ? t("templates.archivedBots", { count: pending.archivedBots }) : "" })
            : org
            ? pending.members.length ? t("orgLibrary.teamSafety") : t("orgLibrary.librarySafety")
            : pending.library
            ? t("teamImport.librarySafety")
            : pending.version === 2
            ? t("teamImport.sharedTeamSafety")
            : pending.kind === "package"
            ? t("templates.packageSafety")
            : t("templates.legacySafety")}
        </p>
      </div>
    </>
  );
}
