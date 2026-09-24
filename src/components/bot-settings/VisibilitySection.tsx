// Who can see this bot, on a workspace served to several people: everyone
// who can sign in (the default), admins only, or the listed addresses (and
// @domain entries) plus admins. Shown to admins only, and not in the desktop
// app, where nobody else signs in. Saving is the change: the server narrows
// every member's lists, conversations, files and live updates at once
// (server/bot-visibility.ts). No confirmation step: it is a setting.
import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { BotVisibility } from "../../../shared/wire";

export type VisibilityMode = "everyone" | "admins" | "people";

export function formFromVisibility(visibility: BotVisibility | undefined): { mode: VisibilityMode; people: string } {
  if (!visibility || visibility === "everyone") return { mode: "everyone", people: "" };
  if (visibility === "admins") return { mode: "admins", people: "" };
  return { mode: "people", people: visibility.people.join("\n") };
}

/** The PATCH value for the form; the server validates each address again. */
export function visibilityFromForm(mode: VisibilityMode, people: string): { ok: true; visibility: BotVisibility } | { ok: false } {
  if (mode !== "people") return { ok: true, visibility: mode };
  const entries = [...new Set(people.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
  return entries.length ? { ok: true, visibility: { people: entries } } : { ok: false };
}

/** One audience, however it was written: absent is everyone, lists compare as sets. */
export function audienceKey(visibility: BotVisibility | undefined): string {
  if (!visibility || visibility === "everyone" || visibility === "admins") return visibility ?? "everyone";
  return JSON.stringify([...new Set(visibility.people.map((entry) => entry.trim().toLowerCase()))].sort());
}

/** Rooms visible to fewer people than this bot: another bot in them has a
 * different audience, or the room kept a narrower one from before (a room's
 * floor never widens on its own; see server/bot-visibility.ts). */
export function mixedRooms(
  bot: Pick<Bot, "id" | "visibility">,
  groups: ReadonlyArray<{ id: string; name: string; memberIds: string[]; dm?: boolean; audienceFloor?: BotVisibility }>,
  bots: ReadonlyArray<Pick<Bot, "id" | "visibility">>,
): Array<{ id: string; name: string }> {
  const mine = audienceKey(bot.visibility);
  return groups
    .filter((group) => !group.dm && group.memberIds.includes(bot.id) && (
      (group.audienceFloor !== undefined && audienceKey(group.audienceFloor) !== mine) ||
      group.memberIds.some((id) => {
        const other = bots.find((candidate) => candidate.id === id);
        return other !== undefined && other.id !== bot.id && audienceKey(other.visibility) !== mine;
      })))
    .map((group) => ({ id: group.id, name: group.name }));
}

const OPTIONS: Array<{ mode: VisibilityMode; key: "botSettings.visibility.everyone" | "botSettings.visibility.admins" | "botSettings.visibility.people" }> = [
  { mode: "everyone", key: "botSettings.visibility.everyone" },
  { mode: "admins", key: "botSettings.visibility.admins" },
  { mode: "people", key: "botSettings.visibility.people" },
];

export function VisibilitySection({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const mixed = mixedRooms(bot, state.groups, state.bots);
  const saved = formFromVisibility(bot.visibility);
  const [mode, setMode] = useState<VisibilityMode>(saved.mode);
  const [people, setPeople] = useState(saved.people);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"saved" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = mode !== saved.mode || (mode === "people" && people.trim() !== saved.people.trim());

  // The stored value changed (another admin, or this save echoed back by the
  // live stream): the form follows it.
  const storedKey = JSON.stringify(bot.visibility ?? "everyone");
  useEffect(() => {
    const next = formFromVisibility(JSON.parse(storedKey) as BotVisibility);
    setMode(next.mode);
    setPeople(next.people);
  }, [bot.id, storedKey]);

  /** The admin's explicit choice to widen a room to what its bots allow. */
  const resetRoom = async (groupId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/groups/${groupId}`, { method: "PATCH", body: JSON.stringify({ resetAudience: true }) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const value = visibilityFromForm(mode, people);
    if (!value.ok) {
      setError(t("botSettings.visibility.needPeople"));
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ visibility: value.visibility }) });
      setStatus("saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-hairline/40 bg-card p-4" data-bot-visibility>
      <p className="text-[12.5px] leading-relaxed text-ink-secondary">{t("botSettings.visibility.subtitle")}</p>
      <div role="radiogroup" aria-label={t("botSettings.visibility.title")} className="flex flex-col gap-1.5">
        {OPTIONS.map((option) => (
          <label key={option.mode} className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
            <input
              type="radio"
              name={`visibility-${bot.id}`}
              value={option.mode}
              checked={mode === option.mode}
              disabled={busy}
              onChange={() => { setMode(option.mode); setStatus(null); setError(null); }}
            />
            {t(option.key)}
          </label>
        ))}
      </div>
      {mode === "people" && (
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("botSettings.visibility.peopleLabel")}
          <textarea
            value={people}
            onChange={(e) => { setPeople(e.target.value); setStatus(null); }}
            placeholder={t("botSettings.visibility.peoplePlaceholder")}
            rows={4}
            disabled={busy}
            className="rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
        </label>
      )}
      <p className="text-[11.5px] leading-relaxed text-ink-secondary">{t("botSettings.visibility.rooms")}</p>
      {mixed.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[12px] leading-relaxed text-ink-secondary" data-visibility-mixed-rooms>
          <p>{t("botSettings.visibility.mixedRooms", { rooms: mixed.map((room) => JSON.stringify(room.name)).join(", ") })}</p>
          <div className="flex flex-wrap gap-2">
            {mixed.map((room) => (
              <button
                key={room.id}
                type="button"
                disabled={busy}
                onClick={() => void resetRoom(room.id)}
                className="rounded-md bg-control px-2 py-1 text-[12px] text-ink hover:bg-control/70 disabled:opacity-50"
              >
                {t("botSettings.visibility.resetRoom", { room: JSON.stringify(room.name) })}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !dirty}
          className={cn("flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50")}
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {busy ? t("botSettings.visibility.saving") : t("botSettings.visibility.save")}
        </button>
        {status === "saved" && !dirty && (
          <span role="status" className="flex items-center gap-1 text-[12px] text-success"><Check size={13} />{t("botSettings.visibility.saved")}</span>
        )}
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
