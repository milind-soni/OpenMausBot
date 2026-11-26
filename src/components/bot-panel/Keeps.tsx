import { Brain, Calendar, Folder, Zap } from "lucide-react";

import { t } from "@/lib/i18n";
import { useFeature } from "@/lib/use-feature";
import type { Routine } from "@/lib/routines";
import { shortPath } from "@/lib/short-path";
import type { Bot } from "@/state/store";
import { isBurgerSource } from "../../../shared/skill-burger/saved";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { skillSwitchOn, useManagedSkills } from "../bot-settings/SkillsSection";
import { panelMemoryNotes } from "./memory-notes";
import type { SimplePageId } from "./page-registry";
import { NavRow } from "./rows";
import { useMemoryDoc } from "./use-memory-doc";

/** What the bot keeps: its memory, its skills, its working folder and its routines, each a row that opens its page. */
export function BotKeeps({ bot, routines, onOpen }: { bot: Bot; routines: readonly Routine[]; onOpen: (page: SimplePageId) => void }) {
  const { capabilities } = useDesktopCapabilities();
  const skills = useManagedSkills(bot), skillBurger = useFeature("skillBurger");
  const memory = useMemoryDoc(bot);
  const skillsOn = skills.skills.filter((skill) => skillSwitchOn(skill) && (skillBurger || !isBurgerSource(skill.source))).length;
  const remembers = memory.docs ? panelMemoryNotes(memory.docs).length > 0 || Boolean(memory.thread?.text.trim()) : null;
  const routinesOn = routines.filter((routine) => routine.enabled).length;
  const memoryValue = bot.memoryEnabled === false ? t("botPanel.memory.off")
    : remembers === false || (remembers === null && memory.error) ? t("botPanel.memory.nothingYet") : undefined;
  return (
    <section data-panel-card="keeps">
      <NavRow data-panel-page="memory" icon={Brain} title={t("botPanel.memoryRow")} value={memoryValue} onClick={() => onOpen("memory")} />
      <NavRow
        data-panel-page="skills"
        icon={Zap}
        title={t("botSettings.simple.skills")}
        value={skills.loading ? undefined : skillsOn > 0 ? skillsOn : t("botPanel.none")}
        onClick={() => onOpen("skills")}
      />
      <NavRow
        data-panel-page="folder"
        icon={Folder}
        title={t("computer.files.folder")}
        value={bot.cwd ? shortPath(bot.cwd, capabilities.host?.homeDir) : t("botPanel.folder.private")}
        onClick={() => onOpen("folder")}
      />
      <NavRow
        data-panel-page="routines"
        icon={Calendar}
        title={t("botSettings.simple.routines")}
        tooltip={routines.length === 0 ? t("botPanel.routines.emptyHint") : undefined}
        value={routinesOn > 0 ? t("botPanel.routinesOn", { count: routinesOn }) : t("botPanel.none")}
        onClick={() => onOpen("routines")}
      />
    </section>
  );
}
