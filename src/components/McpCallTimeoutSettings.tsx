import { SETTINGS_INLINE_INPUT, SettingRow } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { useEffect, useRef, useState } from "react";

import {
  MAX_MCP_CALL_TIMEOUT_MINUTES,
  MIN_MCP_CALL_TIMEOUT_MINUTES,
  mcpCallTimeoutMinutes,
  parseMcpCallTimeoutMinutes,
} from "@/lib/mcp-call-timeout";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";

export function McpCallTimeoutSettings() {
  const { state, dispatch } = useStore();
  const confirmedMinutes = mcpCallTimeoutMinutes(state.config);
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
    const parsed = parseMcpCallTimeoutMinutes(value);
    if (!parsed.ok) {
      setError(t("settings.mcpCalls.range"));
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ mcp: { callTimeoutMinutes: parsed.minutes } }),
      });
      dispatch({ type: "configStatus", config });
      setValue(String(mcpCallTimeoutMinutes(config)));
      setDirty(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.mcpCalls.error"));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <SettingRow title={t("settings.limits.toolTime")} subtitle={t("settings.limits.toolTimeLine")}
      message={error ? <span id="mcp-call-timeout-error" role="alert" className="text-danger">{error}</span> : undefined}>
      <span className="flex items-center gap-2 text-[13px] leading-5 text-ink-secondary">
        <input
          id="mcp-call-timeout"
          type="number"
          min={MIN_MCP_CALL_TIMEOUT_MINUTES}
          max={MAX_MCP_CALL_TIMEOUT_MINUTES}
          step={1}
          inputMode="numeric"
          value={value}
          disabled={saving}
          aria-label={t("settings.limits.toolTime")}
          aria-invalid={Boolean(error)}
          title={t("settings.mcpCalls.help")}
          onChange={(event) => {
            setValue(event.target.value);
            setDirty(true);
            setError("");
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={cn(SETTINGS_INLINE_INPUT, error && "border-danger/60")}
        />
        {t("settings.mcpCalls.minutes")}
      </span>
    </SettingRow>
  );
}
