import { useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { sameFields, useStoreSelector } from "@/state/store-select";
import { KeysLink } from "../keys/KeysLink";
import { Select } from "../Select";
import { useBotEditor } from "./BotEditorContext";
import { inputCls } from "./field";

/** The picker's last choice, which opens the alias field; no SSH alias can contain a space. */
const OTHER_ALIAS = " other";

/**
 * A bot's own VPS server: one of the named servers from Settings, or any SSH alias typed in.
 * PATCHed directly, not via updateBot: the server refuses a move while the bot's computer still lives on the old host.
 */
export function VpsAliasField({ bot }: { bot: Bot }) {
  const { request: api } = useBotEditor();
  const state = useStoreSelector((s) => ({ config: s.config }), sameFields);
  const defaultAlias = state.config?.vps?.sshAlias ?? "";
  // The default server is already the first choice; a named copy of it would only repeat it.
  const servers = (state.config?.vps?.servers ?? []).filter((server) => server.sshAlias !== defaultAlias);
  const [draft, setDraft] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the old server could not be reached: the move went ahead, and this says what may be left there.
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (alias: string | null) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api<{ notice?: string }>(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ vpsAlias: alias }) });
      setNotice(saved?.notice ?? null);
      setDraft(null);
      setTyping(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const current = bot.vpsAlias ?? "";
  const value = draft ?? current;
  // With no named servers the field stays as it was: one alias box.
  const picking = servers.length > 0;
  // A pick is only a draft until Save: moving a bot to another server is a real move, never a stray click.
  const pick = (picked: string) => {
    setError(null);
    setTyping(picked === OTHER_ALIAS);
    setDraft(picked === OTHER_ALIAS ? "" : picked === current ? null : picked);
  };
  return (
    <div className="mt-3 rounded-lg bg-inset p-3">
      <div className="text-[13px] text-ink">{t("botAccess.cloud.server")}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">
        {picking
          ? t("botAccess.cloud.serverPickHint")
          : defaultAlias
            ? t("botAccess.cloud.serverDefault", { alias: defaultAlias })
            : t("botAccess.cloud.serverNoDefault")} <KeysLink id="vps" />
      </div>
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save(value.trim() || null);
        }}
      >
        {picking && (
          <Select
            className="min-w-0 flex-1"
            aria-label={t("botAccess.cloud.serverPick")}
            value={typing ? OTHER_ALIAS : value}
            disabled={saving}
            onChange={(e) => pick(e.target.value)}
          >
            <option value="">{defaultAlias ? t("botAccess.cloud.serverPickDefault", { alias: defaultAlias }) : t("botAccess.cloud.serverPickNone")}</option>
            {servers.map((server) => (
              <option key={server.sshAlias} value={server.sshAlias}>{`${server.name} (${server.sshAlias})`}</option>
            ))}
            {current && !servers.some((server) => server.sshAlias === current) && <option value={current}>{current}</option>}
            <option value={OTHER_ALIAS}>{t("botAccess.cloud.serverPickOther")}</option>
          </Select>
        )}
        {(!picking || typing) && (
          <input
            className={cn(inputCls, "font-mono text-[13px]")}
            placeholder={defaultAlias || t("botAccess.cloud.serverPlaceholder")}
            value={value}
            aria-label={t("botAccess.cloud.server")}
            onChange={(e) => setDraft(e.target.value)}
          />
        )}
        <button
          type="submit"
          disabled={saving || draft === null || (typing && !value.trim())}
          className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {t("botAccess.cloud.serverSave")}
        </button>
      </form>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {notice && <div role="status" className="mt-2 break-words text-[12px] text-ink-secondary">{notice}</div>}
    </div>
  );
}
