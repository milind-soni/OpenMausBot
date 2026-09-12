// The exit beat: the seeded bot gets a name, a color, and one standing
// instruction. This is the first touch of bot settings, so every field is
// optional with a sensible default and Finish always works, even when the
// save fails (the bot can be edited later from its settings).
import { useEffect, useState } from "react";
import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MAUS_COLOR_NAMES, MAUS_COLORS, type MausColor } from "@/lib/mascot";
import { api, type Bot } from "@/state/store";
import { inputClass, PrimaryButton, QuietButton, staggerIndex, type BeatProps } from "./shared";

const SOUL_LINE_LIMIT = 200;

/** The instruction line joins whatever SOUL the bot already has rather than
 * replacing it; a bot imported from a team keeps its playbook. */
function soulWithLine(existing: string | undefined, line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const current = existing?.trimEnd() ?? "";
  return current ? `${current}\n\n${trimmed}` : trimmed;
}

export function MeetYourBotBeat({
  bot,
  onFinish,
  setMascot,
  bump,
}: Pick<BeatProps, "setMascot" | "bump"> & {
  bot: Bot | null;
  onFinish: () => void;
}) {
  const [name, setName] = useState(bot?.name ?? "");
  const [color, setColor] = useState<MausColor>(bot?.color ?? "green");
  const [line, setLine] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setMascot("celebrate");
    bump("celebrate");
    const settle = setTimeout(() => setMascot("happy"), 1600);
    return () => clearTimeout(settle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!bot) {
      onFinish();
      return;
    }
    const patch: Record<string, unknown> = {};
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== bot.name) patch.name = trimmedName;
    if (color !== bot.color) patch.color = color;
    const soul = soulWithLine(bot.soul, line);
    if (soul !== undefined) patch.soul = soul;
    if (!Object.keys(patch).length) {
      onFinish();
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      onFinish();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stagger flex flex-col">
      <p className="animate-rise mt-1 text-[13.5px] leading-relaxed text-ink-secondary" style={staggerIndex(0)}>
        {t("onboarding.bot.intro")}
      </p>

      <div className="animate-rise mt-5 flex items-center gap-4" style={staggerIndex(1)}>
        {/* the bot itself, in its chosen color, next to the guide */}
        <MausAvatar color={color} state="happy" size={64} label={name || bot?.name} />
        <div className="min-w-0 flex-1">
          <label className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary" htmlFor="welcome-bot-name">
            {t("onboarding.bot.name")}
          </label>
          <input
            id="welcome-bot-name"
            autoFocus
            type="text"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
            placeholder={bot?.name}
            className={`mt-1 ${inputClass}`}
          />
        </div>
      </div>

      <div className="animate-rise mt-4" style={staggerIndex(2)}>
        <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">{t("onboarding.bot.color")}</div>
        <div role="radiogroup" aria-label={t("onboarding.bot.color")} className="mt-2 flex flex-wrap gap-2">
          {MAUS_COLOR_NAMES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === color}
              aria-label={t("onboarding.bot.colorAria", { color: c })}
              onClick={() => {
                setColor(c);
                bump("customize");
              }}
              className={cn(
                "size-7 rounded-full border-2 transition-transform duration-150 hover:scale-110 active:scale-95",
                c === color ? "border-ink" : "border-transparent",
              )}
              style={{ backgroundColor: MAUS_COLORS[c] }}
            />
          ))}
        </div>
      </div>

      <div className="animate-rise mt-4" style={staggerIndex(3)}>
        <label className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary" htmlFor="welcome-bot-soul">
          {t("onboarding.bot.soul")}
        </label>
        <input
          id="welcome-bot-soul"
          type="text"
          value={line}
          maxLength={SOUL_LINE_LIMIT}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder={t("onboarding.bot.soulPlaceholder")}
          className={`mt-1 ${inputClass}`}
        />
      </div>

      {failed && (
        <div className="animate-rise mt-4 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[13px] text-danger" role="alert">
          {t("onboarding.bot.error")}
        </div>
      )}

      <PrimaryButton onClick={() => void save()} disabled={saving} className="animate-rise mt-5" style={staggerIndex(4)}>
        {saving ? t("onboarding.bot.saving") : t("onboarding.bot.finish")}
      </PrimaryButton>
      {failed && (
        <QuietButton onClick={onFinish} className="mt-3 self-center">
          {t("onboarding.bot.finishAnyway")}
        </QuietButton>
      )}
    </div>
  );
}
