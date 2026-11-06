import { useRef, useState } from "react";
import { Plus, Search, Sparkles, X } from "lucide-react";

import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { t } from "@/lib/i18n";
import { FLAG_KEY, fromLabel, matchesSkill, SKILLS_SEARCH_FROM, skillTitle, useSkills, whoLabel, type SkillWire } from "@/lib/skills";
import { useStore } from "@/state/store";
import { choiceItem, QuietMenu } from "../bot-access/ShareControls";
import { PanelTabs, takeTabSwitch } from "./PanelTabs";
import { useDialog } from "./use-dialog";
import { AddSkillDialog, ChooseBotsDialog, SkillDetailDialog } from "./SkillDialogs";

/** Names for bot ids, and whether "all" reads as the whole team. */
export function useSkillWords() {
  const { state } = useStore();
  const botName = (id: string) => state.bots.find((bot) => bot.id === id)?.name;
  return { botName, team: Boolean(state.config?.team) };
}

/** The one menu on a skill's row: who may use it. */
export function WhoMenu({ skill, disabled, onAll, onChoose, onOff }: {
  skill: SkillWire;
  disabled?: boolean;
  onAll: () => void;
  onChoose: () => void;
  onOff: () => void;
}) {
  const { botName, team } = useSkillWords();
  const chosen = skill.who === "bots" && skill.bots.length > 0;
  const items = [
    choiceItem("all", t(team ? "skills.who.team" : "skills.who.all"), skill.who === "all", onAll, { disabled }),
    choiceItem("bots", t("skills.who.choose"), chosen, onChoose, { disabled }),
    choiceItem("off", t("skills.who.off"), !chosen && skill.who !== "all", onOff, { disabled }),
  ];
  return (
    <QuietMenu
      label={t("skills.who.menu", { name: skillTitle(skill) })}
      shown={whoLabel(skill.who, skill.bots, botName, team)}
      items={items}
    />
  );
}

/** Title, the source in quiet words, one line of what it does, and the reason it waits, if it does. */
export function SkillText({ skill, source = true }: { skill: SkillWire; source?: boolean }) {
  const { botName } = useSkillWords();
  return (
    <span className="block min-w-0">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="max-w-full shrink-0 truncate text-[14px] font-medium leading-5 text-ink">{skillTitle(skill)}</span>
        {source && <span className="min-w-0 truncate text-[12px] leading-4 text-ink-tertiary">{fromLabel(skill.from, botName)}</span>}
      </span>
      <span className="mt-0.5 block truncate text-[13px] leading-[18px] text-ink-secondary">{skill.description}</span>
      {skill.flag && <span className="mt-0.5 block text-[12px] leading-4 text-warning">{t(FLAG_KEY[skill.flag])}</span>}
    </span>
  );
}

/** The whole list: every skill once, with who may use it. */
export function SkillsBody({ skills, onAdd }: { skills: ReturnType<typeof useSkills>; onAdd: () => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const list = skills.skills;
  const find = (id: string | null) => list?.find((skill) => skill.id === id) ?? null;
  const shown = list?.filter((skill) => matchesSkill(skill, query)) ?? [];
  const opened = find(open);
  const choosingSkill = find(choosing);

  const menu = (skill: SkillWire) => (
    <WhoMenu
      skill={skill}
      disabled={skills.busy}
      onAll={() => void skills.setWho(skill, "all")}
      onChoose={() => setChoosing(skill.id)}
      onOff={() => void skills.setWho(skill, "off")}
    />
  );

  return (
    <>
      {list && list.length > SKILLS_SEARCH_FROM && (
        <label className="mb-3 flex h-9 items-center gap-2.5 rounded-full bg-control/70 px-3.5 focus-within:ring-1 focus-within:ring-accent">
          <Search size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          <input
            data-skills-search
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("skills.search")}
            aria-label={t("skills.search")}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </label>
      )}
      {list === null ? (
        <p className="py-10 text-center text-[13px] text-ink-secondary">{t("common.checking")}</p>
      ) : list.length === 0 ? (
        <div data-skills-empty className="flex flex-col items-center px-6 py-12 text-center">
          <Sparkles size={22} aria-hidden="true" className="text-ink-tertiary" />
          <p className="mt-3 max-w-[340px] text-[14px] leading-5 text-ink-secondary">{t("skills.empty")}</p>
          <button type="button" onClick={onAdd} className="ui-button ui-button-primary mt-4 rounded-full px-4">
            <Plus size={15} aria-hidden="true" />{t("skills.add")}
          </button>
        </div>
      ) : shown.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-ink-secondary">{t("skills.library.noMatches")}</p>
      ) : (
        <ul data-skills-list className="divide-y divide-ink/[0.06] overflow-hidden rounded-[14px] border border-ink/[0.06]">
          {shown.map((skill) => (
            <li key={skill.id} data-skill={skill.id} className="flex items-center gap-3 py-2.5 pe-2 ps-4">
              <button type="button" onClick={() => setOpen(skill.id)} className="min-w-0 flex-1 text-start" aria-label={t("skills.open", { name: skillTitle(skill) })}>
                <SkillText skill={skill} />
              </button>
              {menu(skill)}
            </li>
          ))}
        </ul>
      )}
      {skills.error && <p role="alert" className="mt-3 text-[13px] text-danger">{skills.error}</p>}
      {opened && !choosingSkill && (
        <SkillDetailDialog skill={opened} who={menu(opened)} busy={skills.busy}
          onRemove={async () => { if (await skills.remove(opened)) setOpen(null); }}
          onClose={() => setOpen(null)} />
      )}
      {choosingSkill && (
        <ChooseBotsDialog skill={choosingSkill} busy={skills.busy}
          onDone={async (bots) => { if (await skills.setWho(choosingSkill, "bots", bots)) setChoosing(null); }}
          onClose={() => setChoosing(null)} />
      )}
    </>
  );
}

/** The Skills tab of the Apps screen: the same frame, header and spacing. */
export function SkillsPanel() {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [inPlace] = useState(takeTabSwitch);
  const [adding, setAdding] = useState(false);
  const skills = useSkills();
  const close = () => dispatch({ type: "togglePlugins", open: false });
  const onKeyDown = useDialog(dialogRef, close);

  return (
    <div className="glass-popup-frame" style={glassPopupFrameStyle()} onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        data-skills-panel
        role="dialog"
        aria-modal="true"
        aria-labelledby="skills-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-in-place={inPlace || undefined}
        className="glass-surface glass-popup animate-pop-in relative flex max-w-[780px] flex-col overflow-hidden rounded-2xl outline-none data-in-place:animate-none"
      >
        <header className="px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
          <div className="flex items-center justify-between gap-3">
            <PanelTabs current="skills" titleId="skills-title" />
            <div className="flex shrink-0 items-center gap-1">
              {skills.skills?.length !== 0 && (
                <button type="button" data-skills-add onClick={() => setAdding(true)} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-medium text-app hover:bg-ink/85">
                  <Plus size={15} aria-hidden="true" />{t("skills.add")}
                </button>
              )}
              <button type="button" onClick={close} aria-label={t("common.close")} className="flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink">
                <X size={18} />
              </button>
            </div>
          </div>
          <p className="mt-0.5 text-[13px] leading-5 text-ink-secondary">{t("skills.subtitle")}</p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-7 sm:px-7">
          <SkillsBody skills={skills} onAdd={() => setAdding(true)} />
        </div>
        {adding && <AddSkillDialog onClose={() => setAdding(false)} onAdded={() => void skills.refresh()} />}
      </div>
    </div>
  );
}
