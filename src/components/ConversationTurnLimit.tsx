import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { parseRoomTurnTimeoutMinutes } from "@/lib/room-turn-timeout";
import { useStore, type Group } from "@/state/store";
import { Select } from "./Select";

export const PRESET_TURN_LIMITS = [30, 60, 120] as const;

const isPresetTurnLimit = (minutes: number): minutes is (typeof PRESET_TURN_LIMITS)[number] =>
  (PRESET_TURN_LIMITS as readonly number[]).includes(minutes);

export function useConversationTurnLimit(group: Group) {
  const { state, dispatch } = useStore();
  const globalMinutes = state.config?.rooms.turnTimeoutMinutes ?? 5;
  const task = group.dm ? undefined : group.tasks?.find((candidate) => candidate.threadId === group.threadId);
  const override = group.dm ? group.turnTimeoutMinutes : task?.turnTimeoutMinutes;
  const saved = typeof override === "number" ? override : null;
  const save = (minutes: number | null) => dispatch({
    type: "setConversationTurnLimit",
    groupId: group.id,
    threadId: group.threadId,
    minutes,
    dm: group.dm === true,
  });
  return { globalMinutes, saved, save };
}

export function ConversationTurnLimit({ group }: { group: Group }) {
  const limit = useConversationTurnLimit(group);
  const { globalMinutes, saved } = limit;
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setCustom(false);
    setError("");
  }, [group.id, group.threadId, saved]);

  const save = (minutes: number | null) => {
    setError("");
    setCustom(false);
    limit.save(minutes);
  };

  if (custom) {
    return (
      <input
        autoFocus
        aria-label={t("room.turnLimit.aria")}
        aria-invalid={Boolean(error)}
        title={error || t("room.turnLimit.help")}
        data-testid="conversation-turn-limit"
        type="number"
        min={1}
        max={1440}
        step={1}
        inputMode="numeric"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setError("");
        }}
        onBlur={() => {
          const parsed = parseRoomTurnTimeoutMinutes(draft);
          if (!parsed.ok) {
            setError(t("settings.roomTurns.range"));
            return;
          }
          save(parsed.minutes);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setCustom(false);
            setError("");
          }
        }}
        className={`h-8 w-[88px] rounded-full border bg-raised/60 px-3 text-[13px] font-medium tabular-nums text-ink outline-none ${
          error ? "border-danger/60" : "border-hairline/40 focus:border-accent"
        }`}
      />
    );
  }

  const value = saved == null ? "default" : isPresetTurnLimit(saved) ? String(saved) : "current";
  return (
    <Select
      variant="pill"
      size="sm"
      className="shrink-0 max-w-[168px]"
      title={t("room.turnLimit.help")}
      aria-label={t("room.turnLimit.aria")}
      data-testid="conversation-turn-limit"
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        if (next === "default") save(null);
        else if (next === "custom") {
          setDraft(saved == null ? "30" : String(saved));
          setCustom(true);
        } else save(Number(next));
      }}
    >
      <option value="default">{t("room.turnLimit.default", { minutes: globalMinutes })}</option>
      {PRESET_TURN_LIMITS.map((minutes) => (
        <option key={minutes} value={String(minutes)}>
          {t("room.turnLimit.minutes", { minutes })}
        </option>
      ))}
      {saved != null && !isPresetTurnLimit(saved) ? (
        <option value="current">{t("room.turnLimit.minutes", { minutes: saved })}</option>
      ) : null}
      <option value="custom">{t("room.turnLimit.custom")}</option>
    </Select>
  );
}
