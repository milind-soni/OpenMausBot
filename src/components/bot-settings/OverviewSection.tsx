import { useState } from "react";
import { ChevronRight, Circle, Sparkles } from "lucide-react";

import type { BotOverview } from "@/lib/bot-overview-types";
import { t } from "@/lib/i18n";
import { whenLabel } from "@/lib/schedule-label";
import type { BotSettingsSection } from "@/state/store";
import { PromptPreview, type PromptPreviewData } from "./PromptPreview";

export function OverviewSection({
  overview,
  refreshError,
  prompt,
  promptError,
  onOpen,
  onSetup,
}: {
  overview: BotOverview | null;
  refreshError?: boolean;
  prompt: PromptPreviewData | null;
  promptError?: boolean;
  onOpen: (section: BotSettingsSection) => void;
  onSetup?: () => void;
}) {
  const [promptOpen, setPromptOpen] = useState(false);

  if (!overview) {
    return <div className="text-[13px] text-ink-secondary">{t("botOverview.loading")}</div>;
  }

  const setup = overview.setup ?? [];
  const remaining = setup.filter((step) => !step.done);
  const setupLabel = (id: string, fallback: string) => t(`botOverview.setup.${id}` as never) || fallback;
  const overviewLine = (line: string) => {
    if (line === "Works in its private workspace.") return t("botOverview.line.privateWorkspace");
    if (line === "Has the built-in browser.") return t("botOverview.line.browser");
    if (line === "Has no connected apps.") return t("botOverview.line.noApps");
    if (line === "Won't act on a schedule.") return t("botOverview.line.noSchedule");
    if (line === "Can talk to the other bot.") return t("botOverview.line.talksToOne");
    if (line === "Talks only to the bots chosen for it.") return t("botOverview.line.talksToChosen");
    const talks = line.match(/^Can talk to all (\d+) other bots, in any department\.$/);
    if (talks) return t("botOverview.line.talksToAll", { count: talks[1]! });
    const inCharge = line.match(/^Also in charge of these departments: (.+)\.$/);
    if (inCharge) return t("botOverview.line.alsoInCharge", { departments: inCharge[1]! });
    const computer = line.match(/^Computer preference: (.+)\.$/);
    if (computer) {
      const preference = computer[1] === "Auto; availability is checked when a task starts" ? t("botOverview.preference.auto") : computer[1] === "cloud computer" ? t("botOverview.preference.cloud") : computer[1] === "Local VM" ? t("botOverview.preference.vm") : computer[1] === "this computer" ? t("botOverview.preference.local") : computer[1] === "browser only" ? t("botOverview.preference.browser") : computer[1];
      return t("botOverview.line.computer", { preference });
    }
    return line;
  };

  return (
    <div className="flex flex-col gap-4">
      {refreshError && (
        <div className="rounded-lg bg-inset px-3 py-2 text-[13px] text-ink-secondary">
          {t("botOverview.refreshError")}
        </div>
      )}

      {remaining.length > 0 && (
        <div className="rounded-xl border border-accent/30 bg-accent/[0.06] p-4">
          <div className="text-[15px] font-medium text-ink">{t("botSetup.ideas")}</div>
          <p className="mt-1 text-[13px] text-ink-secondary">{t("botSetup.optional")}</p>
          <ul className="mt-2 flex flex-col gap-1">
            {remaining.map((step) => (
              <li key={step.id}>
                {!step.section ? (
                  <div className="flex items-center gap-2.5 px-1 py-1 text-[13px] text-ink">
                    <Circle aria-hidden="true" size={14} className="shrink-0 text-ink-secondary" />
                    <span>{setupLabel(step.id, step.label)}</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpen(step.section!)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1 text-left text-[13px] text-ink hover:bg-inset"
                  >
                    <Circle aria-hidden="true" size={14} className="shrink-0 text-ink-secondary" />
                    <span className="flex-1">{setupLabel(step.id, step.label)}</span>
                    <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-secondary rtl:-scale-x-100" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {onSetup && (
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={onSetup}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110"
              >
                <Sparkles size={14} /> {t("botSetup.withBot")}
              </button>
              <span className="text-[12px] text-ink-secondary">{t("botSetup.help")}</span>
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{overview.who.name}</div>
        {overview.who.title && <div className="mt-0.5 text-[13px] text-ink-secondary">{overview.who.title}</div>}
        {overview.who.blurb && <p className="mt-2 text-[13px] leading-relaxed text-ink">{overview.who.blurb}</p>}
        {overview.who.soulLead && (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2.5">
            <p className="text-[13px] leading-relaxed text-ink-secondary">{overview.who.soulLead}</p>
            <button
              type="button"
              onClick={() => onOpen("soul")}
              className="mt-1.5 rounded-md text-[12px] font-medium text-accent-text hover:underline"
            >
              {t("botOverview.readAll")}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("botOverview.does")}</div>
        {overview.does.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-secondary">{t("botOverview.doesEmpty")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink">
            {overview.does.map((line, i) => (
              <li key={i}>{overviewLine(line)}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("botOverview.canReach")}</div>
        {overview.reaches.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-secondary">{t("botOverview.reachEmpty")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink">
            {overview.reaches.map((line, i) => (
              <li key={i}>{overviewLine(line)}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">{t("botOverview.wont")}</div>
        <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink">
          {overview.wont.map((line, i) => (
            <li key={i}>{overviewLine(line)}</li>
          ))}
        </ul>
      </div>

      <PromptPreview
        data={prompt}
        error={promptError}
        open={promptOpen}
        onToggle={() => setPromptOpen((current) => !current)}
      />

      <div className="rounded-xl bg-card p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[15px] font-medium text-ink">{t("botOverview.recentChanges")}</div>
          <button
            type="button"
            onClick={() => onOpen("history")}
            className="shrink-0 text-[12px] text-ink-secondary hover:text-ink"
          >
            {t("botOverview.viewAll")} <ChevronRight size={14} aria-hidden="true" className="inline align-[-2px] rtl:-scale-x-100" />
          </button>
        </div>
        {overview.recent.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-secondary">{t("botOverview.recentEmpty")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px] text-ink">
            {overview.recent.map((entry, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{entry.summary}</span>
                <span className="shrink-0 text-[12px] text-ink-secondary">· {whenLabel(entry.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
