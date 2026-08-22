import { useEffect, useRef, useState } from "react";

import {
  MAX_ROOM_TURN_TIMEOUT_MINUTES,
  MIN_ROOM_TURN_TIMEOUT_MINUTES,
  createExclusiveSaveGate,
  saveRoomTurnTimeoutMinutes,
} from "@/lib/room-turn-timeout";
import { api, useStore, type ConfigStatus } from "@/state/store";

export function RoomTurnTimeoutSettings() {
  const { state, dispatch } = useStore();
  const confirmedMinutes = state.config?.rooms.turnTimeoutMinutes ?? 5;
  const [value, setValue] = useState(String(confirmedMinutes));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveGateRef = useRef(createExclusiveSaveGate());

  useEffect(() => {
    if (!dirty) setValue(String(confirmedMinutes));
  }, [confirmedMinutes, dirty]);

  const save = async () => {
    if (!dirty || !saveGateRef.current.tryStart()) return;
    setSaving(true);
    try {
      let savedConfig: ConfigStatus | undefined;
      const result = await saveRoomTurnTimeoutMinutes(value, async (minutes) => {
        const config = await api("/api/config", {
          method: "PUT",
          body: JSON.stringify({ rooms: { turnTimeoutMinutes: minutes } }),
        });
        savedConfig = config;
        return config.rooms.turnTimeoutMinutes;
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      if (savedConfig) dispatch({ type: "configStatus", config: savedConfig });
      setValue(String(result.minutes));
      setDirty(false);
      setError("");
    } finally {
      saveGateRef.current.finish();
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="room-turn-timeout" className="text-[13px] font-medium text-ink">
        Maximum turn length
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
        <span className="pr-3 text-[13px] text-ink-secondary">minutes</span>
      </div>
      <p id="room-turn-timeout-help" className="text-[12px] leading-relaxed text-ink-secondary">
        Applies to every bot turn in rooms. Direct chats use the inactivity watchdog instead.
      </p>
      {error ? (
        <p id="room-turn-timeout-error" role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
