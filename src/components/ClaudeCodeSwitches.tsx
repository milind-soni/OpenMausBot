import { useState } from "react";
import { claudeUserMcpEnabled, claudeUserSkillsEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Switch } from "./SettingsPrimitives";

type Feature = "claudeUserMcp" | "claudeUserSkills";

function ClaudeConfigSwitch({ feature, enabled, prefix }: { feature: Feature; enabled: boolean; prefix: "mcp.claude" | "mcp.claudeSkills" }) {
  const { dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { [feature]: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 flex items-start justify-between gap-4 rounded-2xl border border-hairline/50 bg-card px-4 py-4 sm:px-5">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-ink">{t(`${prefix}.title` as LocaleKey)}</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t(`${prefix}.desc` as LocaleKey)}</p>
        {failed && <p role="alert" className="mt-1 text-[12px] text-danger">{t("mcp.claude.error")}</p>}
      </div>
      <Switch
        checked={enabled}
        aria-label={t(`${prefix}.aria` as LocaleKey)}
        disabled={saving}
        onClick={() => void toggle()}
        className="mt-0.5 shrink-0 disabled:cursor-wait disabled:opacity-50"
      />
    </div>
  );
}

/** What Claude bots take from this machine's own Claude Code setup: its MCP servers, and its skills. */
export function ClaudeCodeSwitches() {
  const { state } = useStore();
  return (
    <>
      <ClaudeConfigSwitch feature="claudeUserMcp" enabled={claudeUserMcpEnabled(state.config)} prefix="mcp.claude" />
      <ClaudeConfigSwitch feature="claudeUserSkills" enabled={claudeUserSkillsEnabled(state.config)} prefix="mcp.claudeSkills" />
    </>
  );
}
