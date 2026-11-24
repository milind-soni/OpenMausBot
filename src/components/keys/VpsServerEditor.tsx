import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { api, type ConfigStatus } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { cn } from "@/lib/cn";
import { vpsAliasOfServerId } from "../../../shared/bot-computers";
import { t } from "@/lib/i18n";
import { KEY_FIELD } from "./KeyRow";

type VpsStatus = ConfigStatus["vps"];
export type VpsNamedServer = NonNullable<VpsStatus["servers"]>[number];
type Range = { min: number; max: number; fallback: number };

export const MEMORY_GB: Range = { min: 2, max: 128, fallback: 4 };
export const CPUS: Range = { min: 1, max: 64, fallback: 2 };
const NO_SERVERS: VpsNamedServer[] = [];

/** One VPS save at a time across every editor: each one sends a whole list, so two at once would undo each other. */
let savingKey: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const setSavingKey = (next: string | null) => { savingKey = next; for (const listener of listeners) listener(); };

/** Which VPS save is under way: "" for an add, an alias for that server, null for none. */
export function useVpsSaving(): string | null {
  return useSyncExternalStore(subscribe, () => savingKey, () => savingKey);
}

/** Saves a VPS patch and takes the new status; resolves with the server's notice, if any. A refusal rejects with its words. */
export function useVpsSave() {
  const dispatch = useStoreDispatch();
  return (body: { vps?: { sshAlias: string; memoryGb?: number; cpus?: number }; vpsServers?: VpsNamedServer[] }, key: string): Promise<string | null> => {
    if (savingKey !== null) return Promise.reject(new Error(""));
    setSavingKey(key);
    return api("/api/config", { method: "PUT", body: JSON.stringify(body) })
      .then(({ notice, ...status }: ConfigStatus & { notice?: string }) => {
        dispatch({ type: "configStatus", config: status });
        return notice ?? null;
      })
      .finally(() => setSavingKey(null));
  };
}

/** Empty is "not set"; anything else must be a whole number in range (null when it is not). */
export function limitValue(text: string, range: Range): number | undefined | null {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= range.min && n <= range.max ? n : null;
}
const asText = (n: number | undefined) => (n === undefined ? "" : String(n));

/** A labelled field of the editor: its name above, the control under it. */
export function Field({ id, label, wide = false, children }: { id: string; label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", wide && "@min-[22rem]/vps:col-span-2")}>
      <label htmlFor={id} className="text-[12px] leading-4 text-ink-secondary">{label}</label>
      {children}
    </div>
  );
}

export function LimitField({ id, value, onChange, range, placeholder, disabled, onEnter }: {
  id: string; value: string; onChange: (value: string) => void; range: Range; placeholder: number; disabled: boolean; onEnter: () => void;
}) {
  return (
    <input id={id} type="number" inputMode="numeric" min={range.min} max={range.max} step={1} value={value}
      onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onEnter()} disabled={disabled}
      placeholder={String(placeholder)} aria-invalid={limitValue(value, range) === null}
      className={cn(KEY_FIELD, "tabular-nums")} />
  );
}

/**
 * One self-hosted server's editor: its name (the alias, for the default server), the memory and cores each bot's
 * desktop on it may use, and Remove. It reads the server from the store by `alias` and saves on its own, so any place
 * that shows a server can open it. Empty limits on a named server use the default server's; the default's use 4 GB
 * and 2 cores. `onRemoved` hears the server's notice after a remove, since the editor is gone by then.
 */
export type VpsServerEditorProps = ({ alias: string; serverId?: never } | { serverId: string; alias?: never }) & {
  onRemoved?: (notice: string | null) => void;
  /** The line under the fields saying what the limits are; a list that says it once for every server turns it off. */
  hint?: boolean;
};

/** Takes the server's SSH alias, or its `vps:<alias>` device id from the computers list or the Devices page. */
export function VpsServerEditor({ onRemoved, hint = true, ...which }: VpsServerEditorProps) {
  const fieldId = useId();
  const alias = which.alias ?? vpsAliasOfServerId(which.serverId ?? "") ?? "";
  const vps = useStoreSelector((s) => s.config?.vps);
  const named = vps?.servers ?? NO_SERVERS;
  const isDefault = Boolean(alias) && vps?.sshAlias === alias;
  const own = isDefault || !alias ? undefined : named.find((server) => server.sshAlias === alias);
  const saving = useVpsSaving();
  const save = useVpsSave();
  const savedName = isDefault ? alias : own?.name ?? "";
  const savedMemory = isDefault ? vps?.memoryGb : own?.memoryGb;
  const savedCpus = isDefault ? vps?.cpus : own?.cpus;
  const inherited = isDefault
    ? { memoryGb: MEMORY_GB.fallback, cpus: CPUS.fallback }
    : { memoryGb: vps?.memoryGb ?? MEMORY_GB.fallback, cpus: vps?.cpus ?? CPUS.fallback };

  const [name, setName] = useState(savedName);
  const [memory, setMemory] = useState(asText(savedMemory));
  const [cpus, setCpus] = useState(asText(savedCpus));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setName(savedName), [savedName]);
  useEffect(() => setMemory(asText(savedMemory)), [savedMemory]);
  useEffect(() => setCpus(asText(savedCpus)), [savedCpus]);

  if (!isDefault && !own) return null;
  const memoryGb = limitValue(memory, MEMORY_GB);
  const cpuCount = limitValue(cpus, CPUS);
  const label = savedName || alias;
  const valid = Boolean(name.trim()) && memoryGb !== null && cpuCount !== null;
  // An empty field on the default saves as 4 GB and 2 cores, the values it stands for.
  const sentMemory = isDefault && memoryGb === undefined ? MEMORY_GB.fallback : memoryGb;
  const sentCpus = isDefault && cpuCount === undefined ? CPUS.fallback : cpuCount;
  const dirty = name.trim() !== savedName || sentMemory !== savedMemory || sentCpus !== savedCpus;
  const busy = saving !== null;

  const run = (body: Parameters<typeof save>[0]) => {
    setError(null);
    setNotice(null);
    return save(body, alias).catch((e) => {
      setError(e.message);
      // A save that failed after the alias changed still says what the old server may hold.
      const failedNotice = (e as { body?: { notice?: unknown } }).body?.notice;
      if (typeof failedNotice === "string") setNotice(failedNotice);
      throw e;
    });
  };
  const submit = () => {
    if (busy || !valid || !dirty || sentMemory === null || sentCpus === null) return;
    const work = isDefault
      ? run({ vps: { sshAlias: name.trim(), memoryGb: sentMemory, cpus: sentCpus } })
      : run({ vpsServers: named.map((server) => (server.sshAlias === alias ? {
        name: name.trim(), sshAlias: alias, ...(sentMemory === undefined ? {} : { memoryGb: sentMemory }), ...(sentCpus === undefined ? {} : { cpus: sentCpus }),
      } : server)) });
    work.then(setNotice, () => undefined);
  };
  const remove = () => {
    if (busy) return;
    const work = isDefault ? run({ vps: { sshAlias: "" } }) : run({ vpsServers: named.filter((server) => server.sshAlias !== alias) });
    work.then((removedNotice) => onRemoved?.(removedNotice), () => undefined);
  };

  const ids = { name: `${fieldId}-name`, memory: `${fieldId}-memory`, cpus: `${fieldId}-cpus` };
  return (
    <div data-vps-server={alias} role="group" aria-label={label} className="flex flex-col gap-3 @container/vps">
      <div className="grid grid-cols-1 gap-3 @min-[22rem]/vps:grid-cols-2">
        <Field id={ids.name} label={t(isDefault ? "keys.vps.field.sshName" : "keys.vps.field.name")} wide>
          <input
            id={ids.name}
            type="text"
            value={name}
            onChange={(e) => { setError(null); setName(e.target.value); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            disabled={busy}
            data-key-input={isDefault ? "" : undefined}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={isDefault ? undefined : `${fieldId}-ssh`}
            className={cn(KEY_FIELD, isDefault && "font-mono")}
          />
          {!isDefault && <span id={`${fieldId}-ssh`} data-vps-ssh-name="" className="break-all text-[12px] leading-4 text-ink-secondary">{t("keys.vps.sshNameLine", { alias })}</span>}
        </Field>
        <Field id={ids.memory} label={t("keys.vps.field.memory")}>
          <LimitField id={ids.memory} value={memory} onChange={setMemory} range={MEMORY_GB} placeholder={inherited.memoryGb} disabled={busy} onEnter={submit} />
        </Field>
        <Field id={ids.cpus} label={t("keys.vps.field.cpus")}>
          <LimitField id={ids.cpus} value={cpus} onChange={setCpus} range={CPUS} placeholder={inherited.cpus} disabled={busy} onEnter={submit} />
        </Field>
      </div>
      {hint && <p data-vps-limits-line="" className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.limitsLine", { memory: inherited.memoryGb, cpus: inherited.cpus })}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={submit} disabled={busy || !valid || !dirty} className="ui-button ui-button-primary shrink-0">
          {saving === alias && dirty ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("common.save")}
        </button>
        <button type="button" onClick={remove} disabled={busy} aria-label={t("keys.vps.servers.removeAria", { name: label })} data-danger="" className="ui-button ms-auto shrink-0 text-danger!">
          {saving === alias && !dirty ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("keys.row.remove")}
        </button>
      </div>
      {notice && <div role="status" className="text-[12px] leading-4 text-ink-secondary">{notice}</div>}
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}
