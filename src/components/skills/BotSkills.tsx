import { useState } from "react";
import { Plus, Search } from "lucide-react";

import { t } from "@/lib/i18n";
import { FLAG_KEY, matchesSkill, SKILLS_SEARCH_FROM, skillTitle, useSkills } from "@/lib/skills";
import { useStore, type Bot } from "@/state/store";
import { Card, ItemRow, LinkRow, NavRow, NoteRow, SwitchRow } from "../bot-panel/rows";
import { AddSkillDialog } from "./SkillDialogs";

/** The skills one bot can use, each with this bot's switch, and the way to add one or see them all. */
export function BotSkills({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const skills = useSkills(bot.id);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const list = skills.skills;
  const shown = list?.filter((skill) => matchesSkill(skill, query)) ?? [];

  return (
    <>
      <Card anchor="skills">
        {list && list.length > SKILLS_SEARCH_FROM && (
          <label className="flex items-center gap-2.5 px-3.5 py-2.5">
            <Search size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("skills.search")} aria-label={t("skills.search")}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none" />
          </label>
        )}
        {list === null ? (
          <NoteRow>{t("common.checking")}</NoteRow>
        ) : list.length === 0 ? (
          <NoteRow>{t("skills.empty")}</NoteRow>
        ) : shown.map((skill) => {
          const hint = <><span className="line-clamp-2">{skill.description}</span>{skill.flag && <span className="mt-0.5 block text-warning">{t(FLAG_KEY[skill.flag])}</span>}</>;
          return skill.from.kind === "project" ? (
            <ItemRow key={skill.id} data-panel-row={`skill:${skill.name}`} title={skillTitle(skill)} hint={hint}>
              <span className="shrink-0 text-[12px] text-ink-tertiary">{t("skills.from.project")}</span>
            </ItemRow>
          ) : (
            <SwitchRow
              key={skill.id}
              data-panel-row={`skill:${skill.name}`}
              title={skillTitle(skill)}
              hint={hint}
              label={t("botSettings.simple.skillToggle", { name: skillTitle(skill) })}
              color={bot.color}
              checked={skill.bots.includes(bot.id)}
              disabled={skills.busy}
              onChange={() => void skills.setForBot(skill, bot.id, !skill.bots.includes(bot.id))}
            />
          );
        })}
        {skills.error && <NoteRow tone="warn">{skills.error}</NoteRow>}
      </Card>
      <Card>
        <NavRow data-panel-action="add-skill" icon={Plus} title={t("skills.add")} drill={false} onClick={() => setAdding(true)} />
        <LinkRow data-panel-link="all-skills" onClick={() => dispatch({ type: "togglePlugins", open: true, surface: "skills" })}>{t("skills.all")}</LinkRow>
      </Card>
      {adding && <AddSkillDialog onClose={() => setAdding(false)} onAdded={() => void skills.refresh()} />}
    </>
  );
}
