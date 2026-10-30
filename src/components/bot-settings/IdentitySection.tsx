import { useState } from "react";
import { DefaultBotHideRow } from "../DefaultBotControls";
import { BookOpen } from "lucide-react";

import { useStore, type Bot } from "@/state/store";
import type { MausMotion, MausState } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { BOT_PROFILE_LIMITS } from "../../../shared/bot-profile";
import { BotProfileAvatarCard } from "../BotProfileAvatarCard";
import { BotInstructionsDialog } from "../BotInstructionsDialog";
import { Field, inputCls } from "./field";
import type { BotPatch } from "./useBotSettingsDerived";
import { useBotEditor } from "./BotEditorContext";
import { PackageProvenance } from "./PackageProvenance";
import { ProposalStatus } from "./ProposalStatus";
import { randomBotName } from "@/lib/random-bot-name";
import { t } from "@/lib/i18n";

export type IdentityPart = "avatar" | "provenance" | "name" | "title" | "blurb";

export function IdentitySection({
  bot,
  patch,
  activeState,
  mascotMotion,
  namePlaceholder,
  parts,
}: {
  bot: Bot;
  patch: (patch: BotPatch) => void;
  activeState: MausState;
  mascotMotion: { kind: Exclude<MausMotion, "none">; nonce: number } | null;
  namePlaceholder?: string;
  parts?: readonly IdentityPart[];
}) {
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const { draft } = useBotEditor();
  const { state } = useStore();
  const shows = (part: IdentityPart) => !parts || parts.includes(part);

  return (
    <div className="flex flex-col gap-4">
      {shows("avatar") && <BotProfileAvatarCard bot={bot} activeState={activeState} mascotMotion={mascotMotion} onPatch={patch} />}
      {shows("provenance") && <PackageProvenance bot={bot} />}

      {shows("name") && <div>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <label htmlFor={`bot-name-${bot.id}`} className="text-[13px] text-ink-secondary">{t("botSettings.identity.name")}</label>
          {draft && <div className="flex flex-wrap gap-1">
            {(["female", "male"] as const).map(kind => <button
              key={kind}
              type="button"
              className="rounded-md px-2 py-1 text-xs text-ink-secondary hover:bg-control hover:text-ink"
              onClick={() => patch({ name: randomBotName(kind, bot.name, state.bots.map(existing => existing.name)) })}
            >{t(kind === "female" ? "newBot.randomFemaleName" : "newBot.randomMaleName")}</button>)}
          </div>}
        </div>
        <ProposalStatus bot={bot} kind="chief" />
        <input
          id={`bot-name-${bot.id}`}
          className={inputCls}
          maxLength={BOT_PROFILE_LIMITS.name}
          value={bot.name}
          placeholder={namePlaceholder}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </div>}
      {shows("title") && <Field label={t("botSettings.identity.title")}>
        <ProposalStatus bot={bot} kind="chief" />
        <input
          className={inputCls}
          maxLength={BOT_PROFILE_LIMITS.title}
          placeholder={t("botSettings.identity.titlePlaceholder")}
          value={bot.title}
          onChange={(e) => patch({ title: e.target.value })}
        />
      </Field>}
      {shows("blurb") && <div className="block">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label htmlFor={`bot-instructions-${bot.id}`} className="text-[13px] text-ink-secondary">
            {t("botSettings.identity.blurb")}
          </label>
          <button
            type="button"
            onClick={() => setInstructionsOpen(true)}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-accent-text hover:bg-accent/10"
          >
            <BookOpen size={12} /> {t("botSettings.identity.viewFull")}
          </button>
        </div>
        <ProposalStatus bot={bot} kind="chief" />
        <textarea
          id={`bot-instructions-${bot.id}`}
          className={cn(inputCls, "min-h-[72px] resize-y leading-relaxed")}
          maxLength={BOT_PROFILE_LIMITS.description}
          placeholder={t("botSettings.identity.blurbPlaceholder")}
          aria-label={t("botSettings.identity.blurb")}
          value={bot.description}
          onChange={(e) => patch({ description: e.target.value })}
        />
        <div className="mt-1.5 flex items-start justify-between gap-3 text-[11px] text-ink-secondary">
          <span>{t("botSettings.identity.blurbHelp")}</span>
          {bot.description.length > 3_000 && (
            <span className="shrink-0 tabular-nums">
              {bot.description.length.toLocaleString()} / {BOT_PROFILE_LIMITS.description.toLocaleString()}
            </span>
          )}
        </div>
      </div>}

      <DefaultBotHideRow bot={bot} />
      {instructionsOpen && <BotInstructionsDialog bot={bot} inline={draft} onClose={() => setInstructionsOpen(false)} />}
    </div>
  );
}
