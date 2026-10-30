import type { RefObject } from "react";
import { BookOpen, Sparkles, Target } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { ComposerSlashCommand } from "@/lib/composer-commands";
import type { MenuMotion } from "./MenuMotion";

/** The composer's / list: room commands like /goal, then the bot's skills. */
export function SlashCommandMenu({ listRef, motion, commands, highlight, onPick, onHighlight }: {
  listRef: RefObject<HTMLDivElement | null>;
  motion: MenuMotion;
  commands: ComposerSlashCommand[];
  highlight: number;
  onPick: (command: ComposerSlashCommand) => void;
  onHighlight: (index: number) => void;
}) {
  if (!motion.shown) return null;
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t("composer.commands.aria")}
      className={cn("absolute bottom-full left-2 z-20 mb-2 max-h-80 w-80 max-w-[calc(100%-1rem)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-hairline/40 bg-raised shadow-lg", motion.className)} {...motion.exitProps}
    >
      <div className="border-b border-hairline/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {t("composer.commands.title")}
      </div>
      {commands.map((command, index) => (
        <button
          key={`${command.kind}:${command.id}`}
          data-command-index={index}
          type="button"
          role="option"
          aria-selected={index === highlight}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(command)}
          onMouseEnter={() => onHighlight(index)}
          className={cn(
            "flex w-full items-center gap-3 px-3 py-2.5 text-left",
            index === highlight ? "bg-raised-hover" : "",
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            {command.kind === "skill" ? (
              <Sparkles size={15} aria-hidden="true" />
            ) : command.id === "goal" ? (
              <Target size={15} aria-hidden="true" />
            ) : (
              <BookOpen size={15} aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[14px] font-medium text-accent">{command.label}</span>
              {command.kind === "skill" && (
                <span className="shrink-0 rounded-full bg-accent/10 px-1.5 text-[11px] font-medium leading-4 text-accent">{t("composer.command.skillTag")}</span>
              )}
            </span>
            <span className="block truncate text-xs text-ink-secondary">
              {command.description}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
