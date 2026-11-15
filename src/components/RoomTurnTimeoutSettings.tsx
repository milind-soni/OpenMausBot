import { SETTINGS_INLINE_INPUT, SettingRow } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { useEffect, useRef, useState } from "react";

import {
  MAX_ROOM_TURN_TIMEOUT_MINUTES,
  MIN_ROOM_TURN_TIMEOUT_MINUTES,
  parseRoomTurnTimeoutMinutes,
} from "@/lib/room-turn-timeout";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";

export function RoomTurnTimeoutSettings() {
  const { state, dispatch } = useStore();
  const confirmedMinutes = state.config?.rooms.turnTimeoutMinutes ?? 5;
  const [value, setValue] = useState(String(confirmedMinutes));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (!dirty) setValue(String(confirmedMinutes));
  }, [confirmedMinutes, dirty]);

  const save = async () => {
    if (!dirty || saveInFlight.current) return;
    const parsed = parseRoomTurnTimeoutMinutes(value);
    if (!parsed.ok) {
      setError(t("settings.roomTurns.range"));
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ rooms: { turnTimeoutMinutes: parsed.minutes } }),
      });
      dispatch({ type: "configStatus", config });
      setValue(String(config.rooms.turnTimeoutMinutes));
      setDirty(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.roomTurns.error"));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <SettingRow title={t("settings.limits.groupTurn")} subtitle={t("settings.limits.groupTurnLine")}
      message={error ? <span id="room-turn-timeout-error" role="alert" className="text-danger">{error}</span> : undefined}>
      {/* The field and its unit fill the card's 160 px control column, so the field starts where the selects do. */}
      <span className="flex w-[160px] items-center gap-2 text-[13px] leading-5 text-ink-secondary">
        <input
          id="room-turn-timeout"
          type="number"
          min={MIN_ROOM_TURN_TIMEOUT_MINUTES}
          max={MAX_ROOM_TURN_TIMEOUT_MINUTES}
          step={1}
          inputMode="numeric"
          value={value}
          disabled={saving}
          aria-label={t("settings.limits.groupTurn")}
          aria-invalid={Boolean(error)}
          title={t("settings.roomTurns.help")}
          onChange={(event) => {
            setValue(event.target.value);
            setDirty(true);
            setError("");
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={cn(SETTINGS_INLINE_INPUT, "w-auto min-w-0 flex-1", error && "border-danger/60")}
        />
        {t("settings.roomTurns.minutes")}
      </span>
    </SettingRow>
  );
}
