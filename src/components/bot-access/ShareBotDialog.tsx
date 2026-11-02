import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Lock, Users } from "lucide-react";

import type { BotAccess, BotAccessLevel, GrantedLevel } from "../../../shared/bot-access";
import { botOwner } from "../../../shared/bot-owner";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { mayChangeOwner, ownerChanged, ownerOf, useTeamPeople, type TeamPeople, type TeamPerson } from "@/state/team-people";
import { MENU_SHEET } from "../menu-recipe";
import { accessOfBot, addablePeople, canShare, levelLabel, levelWhenAdded, nameOf, personOf, saveAccess, saveOwner, withPerson } from "./access";
import { choiceItem, EntryFace, LevelMenu, QuietMenu } from "./ShareControls";

export interface AccessChange { before: BotAccess; after: BotAccess; text: string }

/** A bot's Share dialog on a team: who has access and at what level, and what everyone in the team gets. A change
 * applies at once; the caller shows it with Undo. `headerMenu` holds what else the opener offers there. */
export function ShareBotDialog({ bot, teamName, onClose, onChanged, headerMenu }: {
  bot: Bot;
  teamName: string;
  onClose: () => void;
  onChanged: (change: AccessChange) => void;
  headerMenu?: ReactNode;
}) {
  const team = useTeamPeople();
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newOwner, setNewOwner] = useState<TeamPerson | null>(null);
  const access = accessOfBot(bot);
  const owner = team ? ownerOf(bot, team) : null;
  const editable = canShare(bot);
  const handsOver = mayChangeOwner(bot, team);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    if (document.activeElement === document.body) dialogRef.current?.focus();
  }, [bot.access, bot.reportsTo, newOwner]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const apply = (after: BotAccess, text: string) => run(async () => {
    await saveAccess(bot.id, after);
    onChanged({ before: access, after, text });
  });
  const handOver = (person: TeamPerson) => run(async () => {
    dispatch({ type: "botPatched", bot: await saveOwner(bot.id, person.email) });
    ownerChanged();
    setNewOwner(null);
  });

  const keepOwner = () => {
    setError("");
    setNewOwner(null);
  };

  const yourRow = !editable && team?.me && bot.yourAccess && bot.yourAccess !== "none"
    ? <PersonRow person={team.me} you data-share-yours trailing={<span className="px-2 text-[13px] text-ink-secondary">{levelLabel(bot.yourAccess)}</span>} /> : null;

  return createPortal(
    <div className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="share-bot-title" tabIndex={-1} data-share-bot={bot.id}
        className="ui-modal flex max-h-full w-full max-w-[480px] flex-col text-ink shadow-2xl outline-none"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !event.defaultPrevented) {
            if (newOwner) keepOwner(); else onClose();
          }
          if (event.key === "Tab") trapTab(event, dialogRef.current);
        }}>
        {newOwner ? (
          <MakeOwner person={newOwner} bot={bot} busy={busy} error={error} onCancel={keepOwner} onConfirm={() => void handOver(newOwner)} />
        ) : <>
          <header className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
            <h2 id="share-bot-title" className="min-w-0 truncate text-[17px] font-semibold">{t("botAccess.title", { bot: bot.name })}</h2>
            {headerMenu}
          </header>
          {editable && team && (
            <div className="relative z-10 shrink-0 px-5 pb-1">
              <AddPerson team={team} access={access} owner={botOwner(bot)} disabled={busy}
                onAdd={(person, level) => void apply(withPerson(access, person.email, level), t("botAccess.toast.added", { name: person.name, level: levelLabel(level) }))} />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2 pt-3">
            <h3 className="mb-1 text-[13px] font-semibold">{t("botAccess.people")}</h3>
            <ul data-share-people className="flex max-h-[min(264px,40vh)] flex-col overflow-y-auto">
              {owner && <PersonRow person={owner} you={owner.you === true} trailing={<span className="px-2 text-[13px] text-ink-secondary">{t("botAccess.owner")}</span>} />}
              {yourRow}
              {editable && Object.entries(access.people).sort(([a], [b]) => nameOf(a, team).localeCompare(nameOf(b, team))).map(([entry, level]) => {
                const person = personOf(entry, team);
                return (
                  <PersonRow key={entry} entry={entry} person={person} you={team?.me?.email === entry}
                    trailing={<LevelMenu value={level} floor={access.everyone} removable disabled={busy} label={t("botAccess.levelFor", { name: nameOf(entry, team) })}
                      onMakeOwner={handsOver && person ? () => { setError(""); setNewOwner(person); } : undefined}
                      onChange={(next) => void apply(withPerson(access, entry, next), next
                        ? t("botAccess.toast.changed", { name: nameOf(entry, team), level: levelLabel(next) })
                        : t("botAccess.toast.removed", { name: nameOf(entry, team) }))} />} />
                );
              })}
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
          <footer className="flex shrink-0 justify-end px-5 pb-4 pt-3">
            <button type="button" onClick={onClose} className="ui-button ui-button-primary rounded-full px-4">{t("common.done")}</button>
          </footer>
        </>}
      </div>
    </div>,
    document.body,
  );
}

function trapTab(event: React.KeyboardEvent, dialog: HTMLElement | null) {
  const controls = dialog?.querySelectorAll<HTMLElement>("input:enabled, button:enabled");
  if (!controls?.length) return;
  const first = controls[0]!, last = controls[controls.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function MakeOwner({ person, bot, busy, error, onCancel, onConfirm }: {
  person: TeamPerson; bot: Bot; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div data-share-make-owner={person.email} className="px-5 pb-4 pt-4">
      <h2 id="share-bot-title" className="text-[17px] font-semibold">{t("botAccess.makeOwnerTitle", { name: person.name })}</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("botAccess.makeOwnerBody", { name: person.name, bot: bot.name })}</p>
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" autoFocus disabled={busy} onClick={onCancel} className="ui-button rounded-full px-4">{t("common.cancel")}</button>
        <button type="button" disabled={busy} onClick={onConfirm} className="ui-button ui-button-primary rounded-full px-4">{t("botAccess.makeOwner")}</button>
      </div>
    </div>
  );
}

function PersonRow({ person, entry, you, trailing, ...data }: { person: TeamPerson | null; entry?: string; you: boolean; trailing: ReactNode; "data-share-yours"?: boolean }) {
  const name = person?.name ?? entry ?? "";
  return (
    <li className="flex min-h-[40px] shrink-0 items-center gap-3 py-1" data-share-person={person?.email ?? entry} {...data}>
      <EntryFace person={person} size={32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] leading-[18px] text-ink">{you ? t("botAccess.you", { name }) : name}</span>
        {person && <span className="block truncate text-[12px] leading-4 text-ink-secondary">{person.email}</span>}
      </span>
      <span className="min-w-0 shrink-0">{trailing}</span>
    </li>
  );
}

function GeneralAccess({ access, teamName, disabled, onChange }: {
  access: BotAccess; teamName: string; disabled: boolean; onChange: (everyone: BotAccessLevel) => void;
}) {
  const everyone = access.everyone !== "none";
  const hint = access.everyone === "view" ? t("botAccess.everyoneHint.view", { team: teamName })
    : access.everyone === "chat" ? t("botAccess.everyoneHint.chat", { team: teamName })
      : access.everyone === "edit" ? t("botAccess.everyoneHint.edit", { team: teamName }) : t("botAccess.onlyAddedHint");
  const only = t("botAccess.onlyAdded"), all = t("botAccess.everyone", { team: teamName });
  return (
    <div className="flex items-center gap-3" data-share-general={access.everyone}>
      <span aria-hidden="true" className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full", everyone ? "bg-accent/15 text-accent" : "bg-ink/[0.08] text-ink-secondary")}>
        {everyone ? <Users size={16} /> : <Lock size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="-ms-2 flex">
          <QuietMenu label={t("botAccess.general")} shown={everyone ? all : only} align="start" className="font-medium text-ink"
            items={[
              choiceItem("none", only, !everyone, () => { if (everyone) onChange("none"); }, { disabled }),
              choiceItem("everyone", all, everyone, () => { if (!everyone) onChange("chat"); }, { disabled }),
            ]} />
        </div>
        <p className="text-[12px] leading-4 text-ink-secondary">{hint}</p>
      </div>
      {everyone && <span className="shrink-0"><LevelMenu value={access.everyone as GrantedLevel} disabled={disabled} label={t("botAccess.everyoneLevel", { team: teamName })} onChange={(level) => { if (level) onChange(level); }} /></span>}
    </div>
  );
}

function AddPerson({ team, access, owner, disabled, onAdd }: {
  team: TeamPeople; access: BotAccess; owner: string | null; disabled: boolean; onAdd: (person: TeamPerson, level: GrantedLevel) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement | null>(null);
  const level = levelWhenAdded(access.everyone);
  const matches = useMemo(() => addablePeople(team, access, owner, query), [team, access, owner, query]);
  const current = Math.min(active, matches.length - 1);
  const showing = open && matches.length > 0;
  useEffect(() => {
    if (showing) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [showing, current]);
  if (!level) return <p className="py-1 text-[13px] text-ink-secondary">{t("botAccess.everyoneEdits")}</p>;
  const add = (person: TeamPerson) => {
    if (disabled) return;
    onAdd(person, level);
    setQuery("");
    setActive(0);
    setOpen(false);
  };
  const move = (by: number) => {
    if (!open) { setOpen(true); return; }
    if (matches.length) setActive((current + by + matches.length) % matches.length);
  };
  return (
    <>
      <input value={query} placeholder={t("botAccess.addPlaceholder")} aria-label={t("botAccess.addPlaceholder")}
        role="combobox" aria-expanded={showing} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={showing ? `${listId}-${current}` : undefined}
        onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
          if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
          if (event.key === "Enter" && showing) { event.preventDefault(); add(matches[current]!); }
          if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); }
        }}
        className="w-full rounded-lg border border-hairline/50 bg-transparent px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-focus focus:outline-none" />
      {open && (
        <ul ref={listRef} id={listId} role="listbox" onMouseDown={(event) => event.preventDefault()}
          className={cn(MENU_SHEET, "absolute inset-x-5 top-full max-h-[min(240px,40vh)] overflow-y-auto")}>
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-[13px] text-ink-secondary">{query.trim() ? t("botAccess.noMatch") : t("botAccess.nobodyLeft")}</li>
          ) : matches.map((person, index) => (
            <li key={person.email} id={`${listId}-${index}`} role="option" aria-selected={index === current} data-share-suggestion={person.email}
              onMouseEnter={() => setActive(index)} onMouseDown={() => add(person)}
              className={cn("flex shrink-0 cursor-pointer items-center gap-3 rounded-md px-2 py-1", index === current && "bg-menu-hover")}>
              <EntryFace person={person} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-[18px] text-ink">{person.name}</span>
                <span className="block truncate text-[12px] leading-4 text-ink-secondary">{person.email}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
