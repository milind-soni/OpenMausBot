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
      // Both rejection branches mean the same thing — out of range — so the
      // sentence comes from the catalog. The parser stays pure and keeps its
      // own English copy for its unit test.
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
    <div className="flex flex-col gap-2">
      <label htmlFor="room-turn-timeout" className="text-[13px] font-medium text-ink">
        {t("settings.roomTurns.label")}
      </label>
      <div
        className={`flex max-w-[220px] items-center rounded-lg border bg-inset ${
          error ? "border-danger/60" : "border-hairline/40 focus-within:border-hairline"
        }`}
      >
        <input
          id="room-turn-timeout"
          type="number"
          min={MIN_ROOM_TURN_TIMEOUT_MINUTES}
          max={MAX_ROOM_TURN_TIMEOUT_MINUTES}
          step={1}
          inputMode="numeric"
          value={value}
          disabled={saving}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "room-turn-timeout-error room-turn-timeout-help" : "room-turn-timeout-help"}
          onChange={(event) => {
            setValue(event.target.value);
            setDirty(true);
            setError("");
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[14px] tabular-nums text-ink focus:outline-none"
        />
        <span className="pr-3 text-[13px] text-ink-secondary">{t("settings.roomTurns.minutes")}</span>
      </div>
      <p id="room-turn-timeout-help" className="text-[12px] leading-relaxed text-ink-secondary">
        {t("settings.roomTurns.help")}
      </p>
      {error ? (
        <p id="room-turn-timeout-error" role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
