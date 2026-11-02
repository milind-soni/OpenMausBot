import { useState } from "react";
import { Trash2, UsersRound, X } from "lucide-react";

import { t } from "@/lib/i18n";
import { deleteTeamGroup, saveTeamGroup, type TeamGroup } from "@/state/team-groups";
import type { TeamPeople } from "@/state/team-people";
import { Select } from "../Select";

/** Settings → Bot access, for the team's admins: its groups of people. A bot's Share dialog gives a group a level, and
 * each member has it while they are in the group. */
export function PeopleGroups({ team, groups }: { team: TeamPeople; groups: readonly TeamGroup[] }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  return (
    <section className="flex flex-col gap-2" data-people-groups>
      <h3 className="text-[14px] font-semibold text-ink">{t("botAccess.groups")}</h3>
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("botAccess.groupsIntro")}</p>
      <ul className="flex flex-col gap-2">
        {groups.map((group) => <GroupCard key={group.id} group={group} team={team} busy={busy} run={run} />)}
      </ul>
      <form className="flex gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) void run(async () => { await saveTeamGroup(null, { name: name.trim(), members: [] }); setName(""); });
      }}>
        <input value={name} disabled={busy} maxLength={60} placeholder={t("botAccess.newGroup")} aria-label={t("botAccess.newGroup")} onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:border-focus focus:outline-none" />
        <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40">{t("botAccess.createGroup")}</button>
      </form>
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    </section>
  );
}

function GroupCard({ group, team, busy, run }: { group: TeamGroup; team: TeamPeople; busy: boolean; run: (work: () => Promise<unknown>) => Promise<void> }) {
  const nameOf = (email: string) => team.people.find((person) => person.email === email)?.name ?? email;
  const addable = team.people.filter((person) => !group.members.includes(person.email)).sort((a, b) => a.name.localeCompare(b.name));
  const save = (members: string[], name = group.name) => run(() => saveTeamGroup(group.id, { name, members }));
  return (
    <li className="rounded-xl border border-hairline/40 bg-card px-3 py-2" data-people-group={group.id}>
      <div className="flex items-center gap-2">
        <UsersRound size={16} className="shrink-0 text-ink-secondary" aria-hidden="true" />
        <input defaultValue={group.name} disabled={busy} maxLength={60} aria-label={t("botAccess.groupName", { name: group.name })}
          onBlur={(event) => { const next = event.target.value.trim(); if (next && next !== group.name) void save(group.members, next); }}
          className="min-w-0 flex-1 bg-transparent text-[14px] font-medium text-ink focus:outline-none" />
        <span className="text-[12px] text-ink-secondary">{t("botAccess.groupMembers", { count: group.members.length })}</span>
        <button type="button" disabled={busy} aria-label={t("botAccess.deleteGroup", { name: group.name })} onClick={() => void run(() => deleteTeamGroup(group.id))}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-danger"><Trash2 size={14} /></button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {group.members.map((email) => (
          <span key={email} className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-[12px] text-ink" data-group-member={email}>
            {nameOf(email)}
            <button type="button" disabled={busy} aria-label={t("botAccess.removeFromGroup", { name: nameOf(email), group: group.name })}
              onClick={() => void save(group.members.filter((one) => one !== email))} className="text-ink-secondary hover:text-ink"><X size={12} /></button>
          </span>
        ))}
        {addable.length > 0 && (
          <Select variant="ghost" aria-label={t("botAccess.addToGroup", { group: group.name })} value="" disabled={busy}
            onChange={(event) => { if (event.target.value) void save([...group.members, event.target.value]); }}>
            <option value="">{t("botAccess.addToGroup", { group: group.name })}</option>
            {addable.map((person) => <option key={person.email} value={person.email}>{person.name === person.email ? person.email : `${person.name} · ${person.email}`}</option>)}
          </Select>
        )}
      </div>
    </li>
  );
}
