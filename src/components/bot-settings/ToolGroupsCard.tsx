import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useStore, type Bot } from "@/state/store";
import { TOOL_GROUP_TOKENS, TOOL_GROUPS, type ToolGroup } from "../../../shared/tool-groups";
import { Switch } from "../SettingsPrimitives";

const GROUP_WORDS: Record<ToolGroup, [LocaleKey, LocaleKey]> = {
  meetings: ["botAccess.toolGroups.meetings", "botAccess.toolGroups.meetingsHint"],
  data: ["botAccess.toolGroups.data", "botAccess.toolGroups.dataHint"],
  pages: ["botAccess.toolGroups.pages", "botAccess.toolGroups.pagesHint"],
  images: ["botAccess.toolGroups.images", "botAccess.toolGroups.imagesHint"],
  email: ["botAccess.toolGroups.email", "botAccess.toolGroups.emailHint"],
};

/** The groups this workspace has, in TOOL_GROUPS order, with the ones this bot has off still listed so they can come back. */
export function shownToolGroups(available: readonly ToolGroup[] | undefined, off: readonly ToolGroup[] | undefined): ToolGroup[] {
  return TOOL_GROUPS.filter((group) => available?.includes(group) || off?.includes(group));
}

export function ToolGroupsCard({ bot, patch }: { bot: Bot; patch: (patch: { toolsOff: ToolGroup[] }) => void }) {
  const { state } = useStore();
  const off = bot.toolsOff ?? [];
  const groups = shownToolGroups(state.config?.toolGroups, off);
  if (groups.length === 0) return null;
  const toggle = (group: ToolGroup) => patch({ toolsOff: off.includes(group) ? off.filter((one) => one !== group) : [...off, group] });
  return (
    <div className="rounded-xl bg-card p-4" data-testid="access-tool-groups">
      <div className="text-[15px] font-medium text-ink">{t("botAccess.toolGroups.title")}</div>
      <p className="mt-0.5 text-[13px] text-ink-secondary">{t("botAccess.toolGroups.description")}</p>
      <div className="mt-3 flex flex-col gap-3">
        {groups.map((group) => {
          const [label, hint] = GROUP_WORDS[group];
          return (
            <div key={group} data-tool-group={group} className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-ink">{t(label)}</div>
                <div className="text-[12px] text-ink-tertiary">
                  {t(hint)} · <span className="tabular-nums">{t("botAccess.toolGroups.size", { tokens: TOOL_GROUP_TOKENS[group].toLocaleString() })}</span>
                </div>
              </div>
              <Switch checked={!off.includes(group)} aria-label={t(label)} onClick={() => toggle(group)} />
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[12px] text-ink-tertiary">{t("botAccess.toolGroups.elsewhere")}</p>
    </div>
  );
}
