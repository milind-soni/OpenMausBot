import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AtSign, Lock, Users, X } from "lucide-react";

import { atLeast, GRANTED_LEVELS, type BotAccess, type BotAccessLevel, type GrantedLevel } from "../../../shared/bot-access";
import { botOwner } from "../../../shared/bot-owner";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { ownerOf, useTeamPeople, type TeamPeople, type TeamPerson } from "@/state/team-people";
import { Select } from "../Select";
import { PersonFace } from "../TeamOwner";
import { accessOfBot, addablePeople, canShare, levelLabel, levelWhenAdded, saveAccess, withPerson } from "./access";

export interface AccessChange { before: BotAccess; after: BotAccess; text: string }

const REMOVE = "remove";

/** A bot's Share dialog on a team: who has access and at what level, and what everyone in the team gets. A change
 * applies at once; the caller shows it with Undo. */
export function ShareBotDialog({ bot, teamName, onClose, onChanged, footer }: {
  bot: Bot;
  teamName: string;
  onClose: () => void;
  onChanged: (change: AccessChange) => void;
  footer?: ReactNode;
}) {
  const team = useTeamPeople();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const access = accessOfBot(bot);
  const owner = team ? ownerOf(bot, team) : null;
  const editable = canShare(bot);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  const apply = async (after: BotAccess, text: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await saveAccess(bot.id, after);
      onChanged({ before: access, after, text });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="share-bot-title" tabIndex={-1} data-share-bot={bot.id}
        className="flex max-h-[90vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl outline-none"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); onClose(); }
          if (event.key === "Tab") trapTab(event, dialogRef.current);
        }}>
        <header className="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
          <h2 id="share-bot-title" className="truncate text-[17px] font-semibold">{t("botAccess.title", { bot: bot.name })}</h2>
          <button type="button" aria-label={t("common.close")} onClick={onClose} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised"><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-2">
          {editable && team && <AddPerson team={team} access={access} owner={botOwner(bot)} disabled={busy}
            onAdd={(person, level) => void apply(withPerson(access, person.email, level), t("botAccess.toast.added", { name: person.name, level: levelLabel(level) }))} />}
          {!editable && <p className="mb-3 text-[13px] leading-relaxed text-ink-secondary" data-share-yours>{yoursLine(bot)}</p>}

          <h3 className="mb-1 mt-3 text-[13px] font-semibold">{t("botAccess.people")}</h3>
          <ul className="flex flex-col">
            {owner && <PersonRow person={owner} you={owner.you === true} trailing={<span className="text-[13px] text-ink-secondary">{t("botAccess.owner")}</span>} />}
            {editable && Object.entries(access.people).sort(([a], [b]) => nameOf(a, team).localeCompare(nameOf(b, team))).map(([entry, level]) => (
              <PersonRow key={entry} entry={entry} person={personOf(entry, team)} you={team?.me?.email === entry}
                trailing={<LevelSelect value={level} floor={access.everyone} disabled={busy} label={t("botAccess.levelFor", { name: nameOf(entry, team) })}
                  onChange={(next) => void apply(withPerson(access, entry, next), next
                    ? t("botAccess.toast.changed", { name: nameOf(entry, team), level: levelLabel(next) })
                    : t("botAccess.toast.removed", { name: nameOf(entry, team) }))} />} />
            ))}
          </ul>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{t("botAccess.admins")}</p>

          {editable && <>
            <h3 className="mb-1.5 mt-4 text-[13px] font-semibold">{t("botAccess.general")}</h3>
            <GeneralAccess access={access} teamName={teamName} disabled={busy}
              onChange={(everyone) => void apply({ everyone, people: access.people }, everyone === "none"
                ? t("botAccess.toast.onlyAdded")
                : t("botAccess.toast.everyone", { team: teamName, level: levelLabel(everyone) }))} />
          </>}
          {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-hairline/40 px-5 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1">{footer}</div>
          <button type="button" onClick={onClose} className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-semibold text-white hover:brightness-110">{t("common.done")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function trapTab(event: React.KeyboardEvent, dialog: HTMLElement | null) {
  const controls = dialog?.querySelectorAll<HTMLElement>("input:enabled, select:enabled, button:enabled");
  if (!controls?.length) return;
  const first = controls[0]!, last = controls[controls.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function yoursLine(bot: Bot): string {
  switch (bot.yourAccess) {
    case "view": return t("botAccess.yours.view", { bot: bot.name });
    case "chat": return t("botAccess.yours.chat", { bot: bot.name });
    default: return t("botAccess.yours.other", { bot: bot.name });
  }
}

const personOf = (entry: string, team: TeamPeople | null): TeamPerson | null => team?.people.find((person) => person.email === entry) ?? null;
const nameOf = (entry: string, team: TeamPeople | null): string => personOf(entry, team)?.name ?? entry;

function PersonRow({ person, entry, you, trailing }: { person: TeamPerson | null; entry?: string; you: boolean; trailing: ReactNode }) {
  const name = person?.name ?? entry ?? "";
  return (
    <li className="flex min-h-[44px] items-center gap-3 py-1" data-share-person={person?.email ?? entry}>
      {person ? <PersonFace person={person} size={28} />
        : <span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary"><AtSign size={14} /></span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-ink">{you ? t("botAccess.you", { name }) : name}</span>
        {person && <span className="block truncate text-[12px] text-ink-secondary">{person.email}</span>}
      </span>
      <span className="shrink-0">{trailing}</span>
    </li>
  );
}

function LevelSelect({ value, floor, disabled, label, onChange }: {
  value: GrantedLevel; floor: BotAccessLevel; disabled: boolean; label: string; onChange: (level: GrantedLevel | null) => void;
}) {
  const shown = atLeast(value, floor) ? value : (floor as GrantedLevel);
  return (
    <Select variant="ghost" aria-label={label} value={shown} disabled={disabled}
      onChange={(event) => onChange(event.target.value === REMOVE ? null : event.target.value as GrantedLevel)}>
      {GRANTED_LEVELS.map((level) => <option key={level} value={level} disabled={!atLeast(level, floor)}>{levelLabel(level)}</option>)}
      <option value={REMOVE}>{t("botAccess.remove")}</option>
    </Select>
  );
}

function GeneralAccess({ access, teamName, disabled, onChange }: {
  access: BotAccess; teamName: string; disabled: boolean; onChange: (everyone: BotAccessLevel) => void;
}) {
  const everyone = access.everyone !== "none";
  const hint = access.everyone === "view" ? t("botAccess.everyoneHint.view", { team: teamName })
    : access.everyone === "chat" ? t("botAccess.everyoneHint.chat", { team: teamName })
      : access.everyone === "edit" ? t("botAccess.everyoneHint.edit", { team: teamName }) : t("botAccess.onlyAddedHint");
  return (
    <div className="flex items-start gap-3" data-share-general={access.everyone}>
      <span aria-hidden="true" className={cn("mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full", everyone ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary")}>
        {everyone ? <Users size={14} /> : <Lock size={14} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Select variant="ghost" aria-label={t("botAccess.general")} value={everyone ? "everyone" : "none"} disabled={disabled}
            onChange={(event) => onChange(event.target.value === "none" ? "none" : "chat")}>
            <option value="none">{t("botAccess.onlyAdded")}</option>
            <option value="everyone">{t("botAccess.everyone", { team: teamName })}</option>
          </Select>
          {everyone && (
            <Select variant="ghost" aria-label={t("botAccess.everyoneLevel", { team: teamName })} value={access.everyone} disabled={disabled}
              onChange={(event) => onChange(event.target.value as GrantedLevel)}>
              {GRANTED_LEVELS.map((level) => <option key={level} value={level}>{levelLabel(level)}</option>)}
            </Select>
          )}
        </div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{hint}</p>
      </div>
    </div>
  );
}

function AddPerson({ team, access, owner, disabled, onAdd }: {
  team: TeamPeople; access: BotAccess; owner: string | null; disabled: boolean; onAdd: (person: TeamPerson, level: GrantedLevel) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const level = levelWhenAdded(access.everyone);
  const matches = useMemo(() => addablePeople(team, access, owner, query).slice(0, 8), [team, access, owner, query]);
  if (!level) return <p className="text-[13px] text-ink-secondary">{t("botAccess.everyoneEdits")}</p>;
  const add = (person: TeamPerson) => {
    onAdd(person, level);
    setQuery("");
    setOpen(false);
  };
  return (
    <div className="relative">
      <input value={query} disabled={disabled} placeholder={t("botAccess.addPlaceholder")} aria-label={t("botAccess.addPlaceholder")}
        role="combobox" aria-expanded={open && matches.length > 0} aria-controls="share-bot-people" aria-autocomplete="list"
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && matches[0]) { event.preventDefault(); add(matches[0]); }
          if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); }
        }}
        className="w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-focus focus:outline-none" />
      {open && (
        <ul id="share-bot-people" role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 max-h-[240px] overflow-y-auto rounded-xl border border-hairline/50 bg-card py-1 shadow-xl">
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-[13px] text-ink-secondary">{query.trim() ? t("botAccess.noMatch") : t("botAccess.nobodyLeft")}</li>
          ) : matches.map((person) => (
            <li key={person.email} role="option" aria-selected="false" onMouseDown={(event) => { event.preventDefault(); add(person); }}
              className="flex cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-raised">
              <PersonFace person={person} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">{person.name}</span>
                <span className="block truncate text-[12px] text-ink-secondary">{person.email}</span>
              </span>
              <span className="text-[12px] text-ink-secondary">{levelLabel(level)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
