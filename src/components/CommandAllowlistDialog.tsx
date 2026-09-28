import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Trash2, X } from "lucide-react";
import type { CommandAllowRule, CommandAllowlistResponse } from "../../shared/command-allowlist";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";

/** Mounted for one captured bot/thread, so switching conversations cannot
 * redirect an in-flight save or reuse another bot's working folder. */
export function CommandAllowlistDialog({ botId, botName, threadId, onClose }: {
  botId: string;
  botName: string;
  threadId?: string;
  onClose: () => void;
}) {
  const { state } = useStore();
  const [data, setData] = useState<CommandAllowlistResponse | null>(null);
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const mounted = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const scopeId = useId();
  const exactId = useId();
  const basePath = `/api/bots/${encodeURIComponent(botId)}/command-allowlist`;
  const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
  const providerName = (id: string) => state.instances.find((instance) => instance.instanceId === id)?.displayName ?? id;

  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      mounted.current = false;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api<CommandAllowlistResponse>(basePath + query, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setCwd(result.context.cwd ?? "");
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [basePath, query, revision]);

  const save = async (rule?: CommandAllowRule) => {
    if (saving || !data || (!rule && (!command.trim() || !cwd.trim() || !data.supported))) return;
    setSaving(rule?.id ?? "add");
    setError(null);
    // Keep focus inside the dialog when the clicked control becomes disabled
    // or its row disappears after a successful deletion.
    dialogRef.current?.focus();
    try {
      const result = await api<CommandAllowlistResponse>(
        basePath + (rule ? `/${encodeURIComponent(rule.id)}` : "") + query,
        rule ? { method: "DELETE" } : {
          method: "POST",
          body: JSON.stringify({ command, cwd: cwd.trim(), providerInstanceId: data.context.providerInstanceId }),
        },
      );
      if (!mounted.current) return;
      setData(result);
      if (!rule) setCommand("");
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) {
        setSaving(null);
        closeRef.current?.focus();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
        if (event.key !== "Tab") return;
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex='0']",
        );
        if (!controls?.length) return;
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={scopeId}
        aria-busy={loading || Boolean(saving) || undefined}
        tabIndex={-1}
        className="flex max-h-[85dvh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h2 id={titleId} className="text-[16px] font-semibold text-ink">{t("commandAllowlist.title")}</h2>
            <p className="mt-1 text-[12px] text-ink-secondary">{t("commandAllowlist.forBot", { name: botName })}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("commandAllowlist.close")}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><X size={17} /></button>
        </div>
        <div className="overflow-y-auto px-5 pb-5">
          <p id={scopeId} className="mt-3 text-[12px] leading-relaxed text-ink-secondary">{t("commandAllowlist.scope")}</p>
          {loading && <p role="status" className="mt-5 flex items-center gap-2 text-[13px] text-ink-secondary">
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />{t("commandAllowlist.loading")}
          </p>}
          {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
            <p>{error}</p>
            {!data && !loading && <button type="button" onClick={() => setRevision((value) => value + 1)}
              className="mt-2 underline underline-offset-2">{t("commandAllowlist.retry")}</button>}
          </div>}
          {data && !loading && <>
            {data.rules.length ? <ul className="mt-4 divide-y divide-hairline/25 rounded-xl border border-hairline/40">
              {data.rules.map((rule) => <li key={rule.id} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <pre tabIndex={0} className="max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink">{rule.command}</pre>
                  <p className="mt-1.5 break-words text-[11px] text-ink-secondary">{providerName(rule.providerInstanceId)}</p>
                  <p className="mt-0.5 break-all font-mono text-[11px] text-ink-secondary">{rule.cwd}</p>
                </div>
                <button type="button" disabled={Boolean(saving)} onClick={() => void save(rule)}
                  aria-label={t("commandAllowlist.removeAria", { command: rule.command })}
                  title={t(saving === rule.id ? "commandAllowlist.removing" : "commandAllowlist.remove")}
                  className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40">
                  {saving === rule.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                </button>
              </li>)}
            </ul> : <p className="mt-4 rounded-xl bg-inset px-3 py-4 text-[13px] text-ink-secondary">{t("commandAllowlist.empty")}</p>}
            {data.supported ? <form className="mt-5 border-t border-hairline/30 pt-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <p className="text-[12px] text-ink-secondary">{t("commandAllowlist.provider")}: <span className="text-ink">{providerName(data.context.providerInstanceId)}</span></p>
              <label className="mt-3 block text-[12px] text-ink-secondary">{t("commandAllowlist.command")}
                <textarea value={command} onChange={(event) => setCommand(event.target.value)} disabled={Boolean(saving)} required rows={2} spellCheck={false}
                  aria-describedby={exactId}
                  className="mt-1.5 w-full resize-y rounded-lg border border-hairline/50 bg-inset px-3 py-2 font-mono text-[12px] text-ink focus:border-accent/60 focus:outline-none disabled:opacity-50" />
              </label>
              <p id={exactId} className="mt-1 text-[11px] leading-relaxed text-ink-secondary">{t("commandAllowlist.exact")}</p>
              <label className="mt-3 block text-[12px] text-ink-secondary">{t("commandAllowlist.folder")}
                <input value={cwd} onChange={(event) => setCwd(event.target.value)} disabled={Boolean(saving)} required spellCheck={false}
                  className="mt-1.5 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 font-mono text-[12px] text-ink focus:border-accent/60 focus:outline-none disabled:opacity-50" />
              </label>
              <div className="mt-4 flex justify-end">
                <button type="submit" disabled={Boolean(saving) || !command.trim() || !cwd.trim()}
                  className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
                  {t(saving === "add" ? "commandAllowlist.adding" : "commandAllowlist.add")}
                </button>
              </div>
            </form> : <p className="mt-4 text-[12px] leading-relaxed text-ink-secondary">{t("commandAllowlist.unsupported")}</p>}
          </>}
        </div>
      </div>
    </div>
  );
}
