import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { narrowsNativeTools, parseToolScope } from "../../../shared/tool-scope";
import { TOOL_SCOPE_SUPPORT } from "../../../shared/tool-scope-support";
import { useBotEditor } from "./BotEditorContext";
import { inputCls } from "./field";

type Draft = { custom: boolean; onlyListed: boolean; allow: string; deny: string };
const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

/** Direct, acknowledged saves: rejected restrictions must not appear saved
 * in the optimistic update queue. AccessSection keys this editor by bot ID. */
export function ToolSelectionCard({ bot, engineKind }: { bot: Bot; engineKind?: string }) {
  const { request } = useBotEditor();
  const saved = parseToolScope(bot.toolScope);
  const scope = saved.ok ? saved.scope : undefined;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const fields = draft ?? {
    custom: bot.toolScope !== undefined, onlyListed: scope?.allow !== undefined,
    allow: scope?.allow?.join("\n") ?? "", deny: scope?.deny?.join("\n") ?? "",
  };
  const proposed = fields.custom ? {
    ...(fields.onlyListed ? { allow: lines(fields.allow) } : {}), deny: lines(fields.deny),
  } : undefined;
  const parsed = parseToolScope(proposed);
  const support = TOOL_SCOPE_SUPPORT[engineKind as keyof typeof TOOL_SCOPE_SUPPORT];
  const restricted = fields.custom && (fields.onlyListed || lines(fields.deny).length > 0);
  const unavailable = restricted && support !== "native-and-mcp"
    && (support !== "mcp" || narrowsNativeTools(proposed));
  const change = (patch: Partial<Draft>) => { setDraft({ ...fields, ...patch }); setError(null); };
  const save = async () => {
    if (!draft || bot.busy || pending.current || !parsed.ok) return;
    pending.current = true; setSaving(true); setError(null);
    try {
      await request(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ toolScope: parsed.scope ?? null }) });
      if (alive.current) setDraft(null);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const example = engineKind === "piAgent" ? "native:read\nnative:edit\nnative:write"
    : engineKind === "grokAgent" ? "native:read_file\nnative:search_replace\nnative:write"
      : support === "mcp" ? "native:*\nmcp:mail:read_notes" : "native:ask_user\nmcp:mail:read_notes";

  return <div className="rounded-xl bg-card p-4">
    <div className="text-[15px] font-medium text-ink">{t("botAccess.tools.title")}</div>
    <p className="mt-0.5 text-[13px] text-ink-secondary">{t("botAccess.tools.description")}</p>
    <p role={saved.ok ? "status" : "alert"} className={`mt-2 text-[12px] ${saved.ok ? "text-ink-secondary" : "text-danger"}`}>
      {!saved.ok ? t("botAccess.tools.corrupt") : scope?.allow?.length === 0 ? t("botAccess.tools.none")
        : scope === undefined ? t("botAccess.tools.all") : t("botAccess.tools.customSaved")}
    </p>
    <label className="mt-3 block text-[13px] text-ink-secondary">
      {t("botAccess.tools.mode")}
      <select aria-label={t("botAccess.tools.title")} disabled={saving || !!bot.busy} value={fields.custom ? "custom" : "all"}
        className={`${inputCls} mt-1 text-[13px]`} onChange={event => change({ custom: event.target.value === "custom", onlyListed: fields.custom ? fields.onlyListed : true })}>
        <option value="all">{t("botAccess.tools.all")}</option>
        <option value="custom">{t("botAccess.tools.custom")}</option>
      </select>
    </label>
    {fields.custom && <fieldset disabled={saving || !!bot.busy} className="mt-3 flex flex-col gap-3">
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={fields.onlyListed} onChange={event => change({ onlyListed: event.target.checked })} />
        {t("botAccess.tools.onlyListed")}
      </label>
      <label className="text-[13px] text-ink-secondary">{t("botAccess.tools.allow")}
        <textarea aria-label={t("botAccess.tools.allow")} disabled={!fields.onlyListed} rows={3} spellCheck={false}
          className={`${inputCls} mt-1 font-mono text-[12px] disabled:opacity-50`} placeholder={example} value={fields.allow} onChange={event => change({ allow: event.target.value })} />
      </label>
      {fields.onlyListed && lines(fields.allow).length === 0 && <p className="text-[12px] text-ink-secondary">{t("botAccess.tools.emptyHint")}</p>}
      <label className="text-[13px] text-ink-secondary">{t("botAccess.tools.exclude")}
        <textarea aria-label={t("botAccess.tools.exclude")} rows={2} spellCheck={false} className={`${inputCls} mt-1 font-mono text-[12px]`}
          placeholder="mcp:mail:send" value={fields.deny} onChange={event => change({ deny: event.target.value })} />
      </label>
      <p className="text-[12px] text-ink-secondary">{t("botAccess.tools.syntax")}</p>
      {engineKind === "grokAgent" && <p className="text-[12px] text-ink-secondary">{t("botAccess.tools.grok")}</p>}
    </fieldset>}
    {unavailable && <p role="alert" className="mt-2 text-[12px] text-danger">
      {t(support === "mcp" ? "botAccess.tools.nativeUnsupported" : "botAccess.tools.unsupported")}
    </p>}
    {!parsed.ok && <p role="alert" className="mt-2 text-[12px] text-danger">{parsed.error}</p>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    {bot.busy && <p className="mt-2 text-[12px] text-ink-secondary">{t("botAccess.tools.busy")}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" disabled={saving || !!bot.busy || !draft || !parsed.ok} onClick={() => void save()}
        className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
        {t(saving ? "botAccess.tools.saving" : "botAccess.tools.save")}
      </button>
      <a href="https://github.com/milind-soni/OpenMausBot/blob/main/docs/tool-selection.md" target="_blank" rel="noreferrer" className="text-[12px] text-ink-secondary underline">{t("botAccess.tools.examples")}</a>
    </div>
  </div>;
}
