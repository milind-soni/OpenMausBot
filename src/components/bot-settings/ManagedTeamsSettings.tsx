import { useState } from "react";
import { t } from "@/lib/i18n";

export function ManagedTeamsSettings({
  name, ownTeam, teams, allowed, allowAll = false, onSave,
}: {
  name: string;
  ownTeam: string;
  teams: string[];
  allowed: string[];
  allowAll?: boolean;
  onSave: (teams: string[], allTeams: boolean) => void;
}) {
  const [selected, setSelected] = useState(allowed);
  const [all, setAll] = useState(allowAll);
  const choices = [...new Set([...teams, ...allowed])].filter(team => team !== ownTeam).sort();
  const changed = all !== allowAll || JSON.stringify([...selected].sort()) !== JSON.stringify([...allowed].sort());
  return (
    <details className="mt-3 border-t border-hairline/40 pt-3">
      <summary className="cursor-pointer text-[13px] font-medium text-ink">{t("botAccess.teams.title")}</summary>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
        {t("botAccess.teams.description", { name })}
      </p>
      <label className="mt-3 flex items-center gap-2 text-[13px] font-medium text-ink">
        <input type="checkbox" className="accent-accent" checked={all} onChange={event => setAll(event.target.checked)} />
        {t("botAccess.teams.all")}
      </label>
      <fieldset disabled={all} className="mt-3 flex max-h-52 flex-col gap-2 overflow-y-auto disabled:opacity-50">
        <legend className="sr-only">{t("botAccess.teams.legend", { name })}</legend>
        {choices.map(team => (
          <label key={team} className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" className="accent-accent" checked={all || selected.includes(team)}
              onChange={event => setSelected(current => event.target.checked
                ? [...current, team] : current.filter(value => value !== team))} />
            {team === "General" || !team ? t("botAccess.teams.general") : team}
          </label>
        ))}
        {!choices.length && <p className="text-[13px] text-ink-secondary">{t("botAccess.teams.empty")}</p>}
      </fieldset>
      <button type="button" disabled={!changed} onClick={() => onSave(selected, all)}
        className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40">
        {t("botAccess.teams.save")}
      </button>
    </details>
  );
}
