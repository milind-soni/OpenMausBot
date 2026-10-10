// The bot settings dialog's Overview section: a plain-language read of a
// single bot, built entirely from server-generated sentences (BotOverview,
// server/bot-overview.ts) so the phone app and this dialog never disagree
// about what a bot does. Pure presentational — no store, no fetch; the
// dialog owns loading, errors, and the section switch (onOpen).
import { useState } from "react";
import { Circle, Sparkles } from "lucide-react";

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
  /** "Set up with the bot": close the dialog and send /setup in the chat. */
  onSetup?: () => void;
}) {
  const [promptOpen, setPromptOpen] = useState(false);

  if (!overview) {
    return <div className="text-[13px] text-ink-secondary">Loading…</div>;
  }

  const setup = overview.setup ?? [];
  const remaining = setup.filter((step) => !step.done);

  return (
    <div className="flex flex-col gap-4">
      {refreshError && (
        <div className="rounded-lg bg-inset px-3 py-2 text-[12.5px] text-ink-secondary">
          Couldn’t refresh — showing the last loaded overview.
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
                    <span>{step.label}</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpen(step.section!)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1 text-left text-[13px] text-ink hover:bg-inset"
                  >
                    <Circle aria-hidden="true" size={14} className="shrink-0 text-ink-secondary" />
                    <span className="flex-1">{step.label}</span>
                    <span className="text-[12px] text-ink-secondary">→</span>
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
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-accent-ink hover:brightness-110"
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
              Read all
            </button>
          </div>
        )}
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Does</div>
        {overview.does.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-secondary">Nothing scheduled or learned yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink">
            {overview.does.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Can reach</div>
        {overview.reaches.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-secondary">Nothing yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink">
            {overview.reaches.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl bg-card p-4">
        <div className="text-[15px] font-medium text-ink">Won&rsquo;t</div>
        <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink">
          {overview.wont.map((line, i) => (
            <li key={i}>{line}</li>
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
          <div className="text-[15px] font-medium text-ink">Recent changes</div>
          <button
            type="button"
            onClick={() => onOpen("history")}
            className="shrink-0 text-[12px] text-ink-secondary hover:text-ink"
          >
            View all →
          </button>
        </div>
        {overview.recent.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-secondary">Nothing changed recently.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px] text-ink">
            {overview.recent.map((entry, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{entry.summary}</span>
                <span className="shrink-0 text-[11.5px] text-ink-secondary">· {whenLabel(entry.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
