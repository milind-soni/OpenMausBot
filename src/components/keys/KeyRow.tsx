import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, ExternalLink, Eye, EyeOff, Loader2, TriangleAlert } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { KeyResult, KeyVia } from "@/lib/analytics-allowlist";
import { keyRemoved, keySaved, keySaveFailure, savedKeyResult } from "@/lib/product-events";
import { InstanceProviderMark } from "../ProviderIcons";
import { keyEntry, keyForInstance, looksLikeOtherKey, savedState, type KeyEntry, type KeyId, type SavedState } from "./key-catalog";
import { checkKey, cleanKey, looksLikeKey, saveKey } from "./key-save";

export const KEY_FIELD = "h-8 w-full min-w-0 rounded-lg border border-hairline/60 bg-inset px-3 font-mono text-[13px] leading-8 text-ink placeholder:text-ink-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 disabled:opacity-60";
export const KEY_ROW = "group flex scroll-mt-24 flex-col gap-2 rounded-[10px] px-4 py-2.5 transition-[background-color,box-shadow] duration-500 data-[key-highlight]:bg-accent/10 data-[key-highlight]:ring-1 data-[key-highlight]:ring-accent/40 motion-reduce:transition-none";
const MASK = "••••••••";

export function KeyMarkIcon({ entry }: { entry: KeyEntry }) {
  const { mark } = entry;
  if ("icon" in mark) {
    const Icon = mark.icon;
    return <Icon size={16} aria-hidden="true" className="shrink-0 text-ink-tertiary transition-colors group-hover:text-ink-secondary group-focus-within:text-ink-secondary" />;
  }
  return <InstanceProviderMark instance={{ driverKind: mark.driverKind, ...(mark.preset ? { icon: { kind: "preset", preset: mark.preset } } : {}) }} size={16} subtle />;
}

export type KeyStatus = { tone: "busy" | "ok" | "bad"; text: string } | null;

export function KeyStatusChip({ status }: { status: KeyStatus }) {
  return (
    <span aria-live="polite" className="flex min-h-5 shrink-0 items-center gap-1 text-[12px] leading-5 text-ink-secondary">
      {status?.tone === "busy" && <Loader2 size={12} aria-hidden="true" className="animate-spin" />}
      {status?.tone === "ok" && <Check size={13} aria-hidden="true" className="text-success" />}
      {status?.tone === "bad" && <CircleAlert size={13} aria-hidden="true" className="text-danger" />}
      {status && <span className={cn(status.tone === "bad" && "text-danger")}>{status.text}</span>}
    </span>
  );
}

export function MaskedKey({ saved, label }: { saved: SavedState; label: string }) {
  return (
    <span data-key-masked className={cn(KEY_FIELD, "block min-w-[min(100%,12rem)] flex-1 select-none truncate text-ink-secondary")}>
      <span aria-hidden="true">{MASK}{saved.last4 ?? ""}</span>
      <span className="sr-only">{saved.last4 ? t("keys.row.endsIn", { label, last4: saved.last4 }) : t("keys.row.savedKey", { label })}</span>
    </span>
  );
}

export function SavedKeyLine({ id }: { id: KeyId }) {
  const { state } = useStore();
  const entry = keyEntry(id);
  const saved = savedState(entry, state.config);
  if (!saved.configured) return null;
  const label = t(entry.labelKey);
  return (
    <div data-key-summary={id} className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-secondary">
      <Check size={13} aria-hidden="true" className="shrink-0 text-success" />
      <span className="shrink-0">{entry.target?.test || entry.target?.verifiedOnSave ? t("keys.connected") : t("common.saved")}</span>
      <span aria-hidden="true" className="truncate font-mono">{MASK}{saved.last4 ?? ""}</span>
      <span className="sr-only">{saved.last4 ? t("keys.row.endsIn", { label, last4: saved.last4 }) : t("keys.row.savedKey", { label })}</span>
    </div>
  );
}

export function RowHeading({ entry, status, titleId }: { entry: KeyEntry; status: KeyStatus; titleId?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center"><KeyMarkIcon entry={entry} /></span>
      <div className="min-w-0 flex-1">
        <div id={titleId} className="text-[14px] leading-5 text-ink">{t(entry.labelKey)}</div>
        <div className="text-[13px] leading-[18px] text-ink-secondary">{t(entry.purposeKey)}</div>
      </div>
      <KeyStatusChip status={status} />
    </div>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']*': (?:\w+: )?/, "") : String(cause);
}

export function KeyRow({
  id,
  row: rowId,
  via = "settings",
  onSaved,
  bare = false,
  rejected: rejectedHere,
  className,
  children,
}: {
  id: KeyId;
  row?: KeyId;
  via?: KeyVia;
  onSaved?: (configured: boolean) => void;
  bare?: boolean;
  rejected?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const { state, dispatch } = useStore();
  const titleId = useId();
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [ownKey, setOwnKey] = useState(false);
  const [busy, setBusy] = useState<"saving" | "checking" | "removing" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [works, setWorks] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"input" | "replace" | null>(null);

  useEffect(() => {
    const goal = focusAfter.current;
    if (!goal) return;
    focusAfter.current = null;
    (goal === "input" ? inputRef.current : replaceRef.current)?.focus();
  });

  const entry = keyEntry(id);
  const row = rowId ? keyEntry(rowId) : entry;
  const target = entry.target;
  if (!target) throw new Error(`${id} is not saved by a key row`);
  const pointer = row.id !== entry.id;
  const label = t(entry.labelKey);
  const saved = savedState(entry, state.config);
  const engineRejected = (state.instances ?? []).some((instance) => instance.access === "api" && keyForInstance(instance.instanceId) === entry.id
    && instance.snapshot.state === "available" && instance.snapshot.authenticated === false);
  const rejected = !works && (rejectedHere ?? (saved.configured && engineRejected));
  const failure = problem ?? (rejected && !busy ? t("keys.testRejected") : null);
  const editing = !saved.configured || replacing;
  const fieldShown = editing && (!saved.included || saved.configured || ownKey);
  const other = fieldShown && draft ? looksLikeOtherKey(row, draft) : null;

  const status: KeyStatus = busy === "saving" ? { tone: "busy", text: t("keys.row.saving") }
    : busy === "removing" ? { tone: "busy", text: t("keys.row.removing") }
      : busy === "checking" ? { tone: "busy", text: t("common.checking") }
        : failure && (saved.configured || !fieldShown) ? { tone: "bad", text: t("keys.row.didntWork") }
          : saved.configured ? { tone: "ok", text: target.test || target.verifiedOnSave || works ? t("keys.connected") : t("common.saved") }
            : saved.included ? { tone: "ok", text: t("keys.includedWithCloudPro") }
              : null;

  const runCheck = async (): Promise<KeyResult> => {
    if (!target.test) return "unverified";
    const mine = ++generation.current;
    setBusy("checking");
    try {
      const check = await checkKey(target.test);
      if (mine === generation.current) {
        setWorks(check.ok);
        setVerdict(check.ok ? check.text : null);
        setProblem(check.ok ? null : check.text);
      }
      return check.result;
    } catch (cause) {
      if (mine === generation.current) setProblem(errorText(cause));
      return "unverified";
    }
  };

  const save = async (raw: string) => {
    const value = cleanKey(raw);
    if (busyRef.current || !value) return;
    if (!looksLikeKey(value)) {
      setNotice(t("keys.notAKey"));
      return;
    }
    busyRef.current = true;
    generation.current += 1;
    const hadFocus = document.activeElement === inputRef.current;
    setBusy("saving");
    setProblem(null);
    setNotice(null);
    setVerdict(null);
    setWorks(false);
    try {
      const status = await saveKey(target, value, !saved.configured);
      dispatch({ type: "configStatus", config: status });
      const now = target.saved(status);
      setDraft("");
      setShown(false);
      setReplacing(false);
      setOwnKey(false);
      if (hadFocus) focusAfter.current = now.configured ? "replace" : "input";
      if (!now.configured) setProblem(t("keys.row.notKept"));
      onSaved?.(now.configured);
      keySaved(target.analytics, via, now.configured && target.test ? await runCheck() : savedKeyResult(target.analytics));
    } catch (cause) {
      setProblem(errorText(cause));
      keySaved(target.analytics, via, keySaveFailure(cause));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const recheck = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setVerdict(null);
    setProblem(null);
    try {
      await runCheck();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    generation.current += 1;
    setBusy("removing");
    setProblem(null);
    setVerdict(null);
    setWorks(false);
    try {
      const status = await saveKey(target, "", false);
      dispatch({ type: "configStatus", config: status });
      setReplacing(false);
      setDraft("");
      onSaved?.(target.saved(status).configured);
      keyRemoved(target.analytics, via);
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const startReplace = () => {
    setReplacing(true);
    setProblem(null);
    setVerdict(null);
    focusAfter.current = "input";
  };

  const cancelReplace = () => {
    setReplacing(false);
    setDraft("");
    setNotice(null);
    focusAfter.current = "replace";
  };

  const field = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[min(100%,12rem)] flex-1">
        <input
          ref={inputRef}
          data-key-input
          type={shown ? "text" : "password"}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); setNotice(null); setProblem(null); }}
          onPaste={(event) => {
            const pasted = cleanKey(event.clipboardData.getData("text"));
            if (!pasted) return;
            event.preventDefault();
            setDraft(pasted);
            setNotice(null);
            setProblem(null);
            if (looksLikeKey(pasted) && !looksLikeOtherKey(row, pasted)) void save(pasted);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save(draft);
            } else if (event.key === "Escape" && replacing) {
              event.preventDefault();
              event.stopPropagation();
              cancelReplace();
            }
          }}
          disabled={busy === "saving"}
          placeholder={replacing ? t("keys.row.newKey") : target.placeholderKey ? t(target.placeholderKey) : target.placeholder}
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
          className={cn(KEY_FIELD, "pr-9")}
        />
        <button
          type="button"
          onClick={() => setShown((current) => !current)}
          aria-label={shown ? t("keys.row.hide") : t("keys.row.show")}
          aria-pressed={shown}
          className="absolute right-0.5 top-1/2 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-ink-tertiary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
        >
          {shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        </button>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        <button type="button" data-key-save className="ui-button ui-button-primary" disabled={!draft.trim() || busy !== null} onClick={() => void save(draft)}>
          {t("common.save")}
        </button>
        {replacing && <button type="button" className="ui-button" onClick={cancelReplace}>{t("common.cancel")}</button>}
      </span>
    </div>
  );

  const masked = (
    <div className="flex flex-wrap items-center gap-2">
      <MaskedKey saved={saved} label={label} />
      <span className="flex shrink-0 items-center gap-2">
        <button ref={replaceRef} type="button" data-key-replace className="ui-button" disabled={busy !== null} onClick={startReplace}>{t("keys.row.replace")}</button>
        {!pointer && <button type="button" data-key-remove className="ui-button" disabled={busy !== null} onClick={() => void remove()}>{t("keys.row.remove")}</button>}
      </span>
    </div>
  );

  const warning = target.warningKey && fieldShown ? t(target.warningKey) : null;
  const note = target.noteKey && fieldShown && !pointer ? t(target.noteKey) : null;

  return (
    <div
      data-key-row={row.id}
      data-api-key-row={pointer ? undefined : entry.id}
      data-key-state={saved.configured ? "saved" : saved.included ? "included" : "empty"}
      aria-labelledby={bare ? undefined : titleId}
      role="group"
      className={cn(KEY_ROW, className)}
    >
      {bare ? status && <KeyStatusChip status={status} /> : <RowHeading entry={row} status={status} titleId={titleId} />}
      <div className={cn("flex flex-col gap-2", !bare && "pl-8")}>
        {fieldShown ? field : saved.configured ? masked : (
          <div>
            <button type="button" data-key-own className="ui-button" onClick={() => { setOwnKey(true); focusAfter.current = "input"; }}>{t("keys.row.useOwn")}</button>
          </div>
        )}
        {(notice || failure || other || warning || note || verdict || (fieldShown && target.href) || (!fieldShown && saved.configured && target.test)) && (
          <div className="flex flex-col gap-1.5 text-[12px] leading-4">
            {notice && <p role="alert" className="text-danger">{notice}</p>}
            {failure && (
              <p role="alert" className="flex gap-1.5 text-danger">
                <CircleAlert size={13} aria-hidden="true" className="mt-px shrink-0" />
                <span>{t("keys.row.failed", { reason: failure })}</span>
              </p>
            )}
            {other && (
              <p className="flex gap-1.5 text-warning">
                <TriangleAlert size={13} aria-hidden="true" className="mt-px shrink-0" />
                <span>{t("keys.row.looksLike", { label: t(other.labelKey) })}</span>
              </p>
            )}
            {warning && (
              <p className="flex gap-1.5 text-warning">
                <TriangleAlert size={13} aria-hidden="true" className="mt-px shrink-0" />
                <span>{warning}</span>
              </p>
            )}
            {note && <p className="text-ink-secondary">{note}</p>}
            {verdict && <p role="status" className="whitespace-pre-line text-ink-secondary">{verdict}</p>}
            {(fieldShown && target.href) || (!fieldShown && saved.configured && target.test) ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {fieldShown && target.href && (
                  <a href={target.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-accent-text hover:underline">
                    {t("keys.row.getKey")}
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                )}
                {!fieldShown && saved.configured && target.test && (
                  <button type="button" data-key-check className="cursor-pointer text-ink-secondary hover:text-ink hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => void recheck()}>
                    {t("common.checkAgain")}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
