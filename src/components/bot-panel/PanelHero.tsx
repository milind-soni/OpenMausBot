import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Crown, Pencil } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { MausState } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import { BOT_PROFILE_LIMITS } from "../../../shared/bot-profile";
import { BotAvatar } from "../Avatar";
import type { BotPatch } from "../bot-settings/useBotSettingsDerived";

const inlineInputCls =
  "rounded-lg border border-accent-border bg-inset px-2 py-[3px] text-center text-ink outline-none placeholder:text-ink-tertiary";

function useInlineEdit(save: (value: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);
  const settled = useRef(false);
  const refocus = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Enter and Escape take away the focused field: focus goes back to the button that opened it, not the page body.
  // A blur commit leaves focus where the person put it.
  useEffect(() => {
    if (draft !== null || !refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus();
  }, [draft]);
  const start = (value: string) => {
    settled.current = false;
    setDraft(value);
  };
  const commit = () => {
    if (draft !== null) save(draft);
    setDraft(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      settled.current = true;
      refocus.current = true;
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      settled.current = true;
      refocus.current = true;
      setDraft(null);
    }
  };
  const onBlur = () => {
    if (settled.current) return;
    commit();
  };
  return { draft, setDraft, start, onKeyDown, onBlur, buttonRef };
}

export function PanelHero({ bot, activeState, patch, editorOpen, onToggleEditor }: {
  bot: Bot;
  activeState: MausState;
  patch: (patch: BotPatch) => void;
  editorOpen: boolean;
  onToggleEditor: () => void;
}) {
  const name = useInlineEdit((value) => {
    const next = value.trim();
    if (next && next !== bot.name) patch({ name: next });
  });
  const label = useInlineEdit((value) => {
    const next = value.trim();
    if (next !== bot.title.trim()) patch({ title: next });
  });
  const title = bot.title.trim();

  return (
    <div className="group/hero flex flex-col items-center text-center">
      <button
        type="button"
        data-panel-avatar
        aria-label={t("botPanel.avatar.edit")}
        aria-expanded={editorOpen}
        onClick={onToggleEditor}
        className="group relative rounded-[24px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
      >
        <BotAvatar bot={bot} size={80} state={activeState} />
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center rounded-[24px] bg-black/0 text-white opacity-0 transition-[opacity,background-color] group-hover:bg-black/40 group-hover:opacity-100 group-focus-visible:bg-black/40 group-focus-visible:opacity-100 group-focus-within:opacity-100 touch:opacity-100 motion-reduce:transition-none"
        >
          <Pencil size={20} />
        </span>
        {bot.chiefOfStaff && (
          <span data-panel-chief title={t("chat.chiefOfStaff")} className="absolute -bottom-0.5 -right-0.5 flex size-[22px] items-center justify-center rounded-full bg-accent text-accent-ink ring-[3px] ring-app">
            <Crown size={12} aria-hidden="true" />
            <span className="sr-only">{t("chat.chiefOfStaff")}</span>
          </span>
        )}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-[calc(100%+4px)] z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-hairline bg-menu px-[7px] py-0.5 text-[12px] text-ink opacity-0 transition-opacity group-hover:opacity-100"
        >
          {t("botPanel.avatar.edit")}
        </span>
      </button>

      <div data-panel-name-row className="mt-2 flex max-w-full items-center justify-center">
        <h2 id="bot-settings-title" className="flex min-w-0 justify-center">
          {name.draft !== null ? (
            <input
              autoFocus
              data-panel-rename-input
              aria-label={t("botSettings.simple.name")}
              maxLength={BOT_PROFILE_LIMITS.name}
              value={name.draft}
              onChange={(event) => name.setDraft(event.target.value)}
              onKeyDown={name.onKeyDown}
              onBlur={name.onBlur}
              className={cn(inlineInputCls, "w-[220px] max-w-full text-[17px] font-medium leading-6")}
            />
          ) : (
            <button
              ref={name.buttonRef}
              type="button"
              data-panel-rename
              title={t("botPanel.rename")}
              onClick={() => name.start(bot.name)}
              className="group/name relative inline-flex max-w-full items-center rounded-[7px] px-1.5 text-[17px] font-medium leading-6 text-ink hover:bg-ink/[0.04]"
            >
              <span className="min-w-0 truncate">{bot.name}</span>
              <Pencil size={13} aria-hidden="true" className="absolute -right-4 shrink-0 text-ink-tertiary opacity-0 transition-opacity group-hover/name:opacity-100 group-focus-visible/name:opacity-100 group-focus-within/name:opacity-100 touch:opacity-100" />
            </button>
          )}
        </h2>
      </div>

      {label.draft !== null ? (
        <input
          autoFocus
          data-panel-label-input
          aria-label={t("botSettings.simple.job")}
          placeholder={t("botSettings.simple.jobPlaceholder")}
          maxLength={BOT_PROFILE_LIMITS.title}
          value={label.draft}
          onChange={(event) => label.setDraft(event.target.value)}
          onKeyDown={label.onKeyDown}
          onBlur={label.onBlur}
          className={cn(inlineInputCls, "mt-[3px] w-[200px] max-w-full text-[13px]")}
        />
      ) : title && (
        <button
          ref={label.buttonRef}
          type="button"
          data-panel-label
          onClick={() => label.start(bot.title)}
          className="mt-px max-w-full truncate rounded-md px-1.5 py-px text-[13px] text-ink-secondary hover:bg-ink/[0.04]"
        >
          {title}
        </button>
      )}
    </div>
  );
}
