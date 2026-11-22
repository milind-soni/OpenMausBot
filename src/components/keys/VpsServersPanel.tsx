import { useEffect, useState } from "react";
import { ChevronRight, Loader2, Minus, Pencil, Plus, Trash2 } from "lucide-react";
import { api, type ConfigStatus } from "@/state/store";
import { serverFetch } from "@/lib/relay-server";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Select } from "../Select";
import { KEY_FIELD } from "./KeyRow";

type NamedServer = NonNullable<ConfigStatus["vps"]["servers"]>[number];
type Limits = { memoryGb?: number; cpus?: number; cpuset?: string };
type ServerEntry = { alias: string; name: string; isDefault: boolean } & Limits;
type Range = { min: number; max: number };

const MEMORY_GB: Range & { fallback: number } = { min: 2, max: 128, fallback: 4 };
const CPUS: Range & { fallback: number } = { min: 1, max: 64, fallback: 2 };
const NO_SERVERS: NamedServer[] = [];
const FIELD_EDGE_BOX = "bg-app shadow-[inset_0_0_0_0.5px_var(--settings-edge,var(--color-hairline))]";
const CPUSET = /^\d{1,4}(-\d{1,4})?(,\d{1,4}(-\d{1,4})?)*$/;

/** Empty is "not set"; anything else must be a whole number in range. */
function limitValue(text: string, range: Range): number | undefined | null {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= range.min && n <= range.max ? n : null;
}

/** Empty is "let the host choose"; anything else is CPU ids like 0,2 or 4-7. */
function pinValue(text: string): string | undefined | null {
  const value = text.replace(/\s+/g, "");
  if (value === "") return undefined;
  return CPUSET.test(value) && value.split(",").every((part) => { const [from, to = from] = part.split("-").map(Number); return from! <= to!; }) ? value : null;
}

/** How many CPUs a valid pin names: "0,2" is 2, "4-7" is 4. */
const pinSize = (pin: string) => pin.split(",").reduce((total, part) => { const [from, to = from] = part.split("-").map(Number); return total + (to! - from! + 1); }, 0);
const tooManyPinned = (cpuset: string | undefined | null, cores: number) => typeof cpuset === "string" && pinSize(cpuset) > cores;

const asText = (n: number | undefined) => (n === undefined ? "" : String(n));

function Caption({ children }: { children: string }) {
  return <span className="whitespace-nowrap text-[11px] uppercase tracking-wide text-ink-tertiary">{children}</span>;
}

function Stepper({ label, unit, value, onChange, range, placeholder, disabled, onEnter, stepLabels }: {
  label: string; unit?: string; value: string; onChange: (value: string) => void; range: Range; placeholder: string; disabled?: boolean; onEnter?: () => void; stepLabels?: boolean;
}) {
  const current = limitValue(value, range);
  const step = (by: number) => onChange(String(Math.min(range.max, Math.max(range.min, (current ?? Number(placeholder)) + by))));
  const arrow = "grid h-full w-[22px] shrink-0 place-items-center text-ink-secondary hover:text-ink disabled:opacity-40";
  return (
    <div className={cn("flex h-8 min-w-0 items-center rounded-lg", FIELD_EDGE_BOX)}>
      <button type="button" onClick={() => step(-1)} disabled={disabled} aria-label={stepLabels === false ? undefined : t("keys.vps.lessAria", { what: label })} className={arrow}>
        <Minus size={13} aria-hidden="true" />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onEnter ? (e) => e.key === "Enter" && onEnter() : undefined}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={current === null}
        className="h-full min-w-0 flex-1 bg-transparent text-center text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      {unit && <em className="shrink-0 text-[11px] not-italic text-ink-tertiary">{unit}</em>}
      <button type="button" onClick={() => step(1)} disabled={disabled} aria-label={t("keys.vps.moreAria", { what: label })} className={arrow}>
        <Plus size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

function PinInput({ value, onChange, label, disabled, onEnter, tooMany }: { value: string; onChange: (value: string) => void; label: string; disabled?: boolean; onEnter?: () => void; tooMany?: boolean }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onEnter ? (e) => e.key === "Enter" && onEnter() : undefined}
      disabled={disabled}
      placeholder={t("keys.vps.pinAuto")}
      aria-label={label}
      aria-invalid={pinValue(value) === null || tooMany === true}
      autoComplete="off"
      spellCheck={false}
      className={cn(KEY_FIELD, "font-mono")}
    />
  );
}

const FIELDS = "flex flex-wrap items-end gap-2";
const WIDTH = { memory: "w-[104px]", cpu: "w-[84px]", pin: "w-[104px]" };

function ServerCard({ server, defaults, busy, disabled, onSave, onRename, onRemove }: {
  server: ServerEntry; defaults: Required<Pick<Limits, "memoryGb" | "cpus">>; busy: string | null; disabled: boolean;
  onSave: (next: Limits) => void; onRename: (next: string) => void; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [rename, setRename] = useState(server.isDefault ? server.alias : server.name);
  const [memory, setMemory] = useState(asText(server.memoryGb));
  const [cpus, setCpus] = useState(asText(server.cpus));
  const [pin, setPin] = useState(server.cpuset ?? "");
  const reset = () => { setMemory(asText(server.memoryGb)); setCpus(asText(server.cpus)); setPin(server.cpuset ?? ""); };
  useEffect(reset, [server.memoryGb, server.cpus, server.cpuset]);
  const renamed = server.isDefault ? server.alias : server.name;
  useEffect(() => setRename(renamed), [renamed]);

  const memoryGb = limitValue(memory, MEMORY_GB);
  const cpuCount = limitValue(cpus, CPUS);
  const cpuset = pinValue(pin);
  const needsValues = server.isDefault && (memoryGb === undefined || cpuCount === undefined);
  const cores = cpuCount ?? defaults.cpus;
  const pinTooMany = tooManyPinned(cpuset, cores);
  const valid = memoryGb !== null && cpuCount !== null && cpuset !== null && !needsValues && !pinTooMany;
  const dirty = memoryGb !== server.memoryGb || cpuCount !== server.cpus || cpuset !== server.cpuset;
  const save = () => {
    if (!valid || !dirty || memoryGb === null || cpuCount === null || cpuset === null) return;
    onSave({ memoryGb, cpus: cpuCount, cpuset });
  };
  const done = () => {
    const next = rename.trim();
    if (!next) return;
    setEditing(false);
    if (next !== renamed) onRename(next);
  };
  const cancel = () => { setRename(renamed); setEditing(false); };
  const saving = busy === `save:${server.alias}`;

  return (
    <div data-vps-server={server.alias} className="flex flex-col gap-2.5">
      <div className="flex min-h-[30px] min-w-0 items-center gap-2">
        {editing ? (
          <>
            <input
              type="text"
              data-key-input
              value={rename}
              onChange={(e) => setRename(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") done(); if (e.key === "Escape") cancel(); }}
              aria-label={server.isDefault ? t("keys.vps.aria") : t("keys.vps.servers.name")}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className={cn(KEY_FIELD, "h-[30px] min-w-0 flex-1", server.isDefault && "font-mono")}
            />
            <button type="button" onClick={done} disabled={disabled || !rename.trim()} className="ui-button ui-button-primary ui-button-md">{t("common.done")}</button>
            <button type="button" onClick={cancel} disabled={disabled} className="ui-button ui-button-md">{t("common.cancel")}</button>
          </>
        ) : (
          <>
            <b className="min-w-0 truncate text-[14px] font-semibold text-ink">{server.name}</b>
            <code className="min-w-0 truncate font-mono text-[12px] text-ink-secondary">{t("keys.vps.aliasLine", { alias: server.alias })}</code>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={disabled}
              aria-label={t("keys.vps.editAria", { name: server.name })}
              title={t("keys.vps.edit")}
              className="grid size-7 shrink-0 place-items-center rounded-[7px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
            >
              <Pencil size={15} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      <div className={FIELDS}>
        <div className={cn("flex min-w-0 flex-col gap-1 max-[480px]:flex-1", WIDTH.memory)}>
          <Caption>{t("keys.vps.col.memory")}</Caption>
          <Stepper label={t("keys.vps.serverMemoryAria", { name: server.name })} unit={t("keys.vps.unitGb")} value={memory} onChange={setMemory} range={MEMORY_GB} placeholder={String(defaults.memoryGb)} disabled={disabled} onEnter={save} />
        </div>
        <div className={cn("flex min-w-0 flex-col gap-1 max-[480px]:flex-1", WIDTH.cpu)}>
          <Caption>{t("keys.vps.col.cpu")}</Caption>
          <Stepper label={t("keys.vps.serverCpusAria", { name: server.name })} value={cpus} onChange={setCpus} range={CPUS} placeholder={String(defaults.cpus)} disabled={disabled} onEnter={save} />
        </div>
        <div className={cn("flex min-w-0 flex-col gap-1 max-[480px]:flex-1", WIDTH.pin)}>
          <Caption>{t("keys.vps.col.pin")}</Caption>
          <PinInput value={pin} onChange={setPin} label={t("keys.vps.serverPinAria", { name: server.name })} disabled={disabled} onEnter={save} tooMany={pinTooMany} />
        </div>
        <span className="flex-1" />
        <button type="button" onClick={save} disabled={disabled || !valid || !dirty} className="ui-button ui-button-primary">
          {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("common.save")}
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={t("keys.vps.deleteAria", { name: server.name })}
          title={t("keys.row.remove")}
          className="grid size-8 shrink-0 place-items-center rounded-lg border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 disabled:opacity-40"
        >
          {busy === server.alias ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
        </button>
      </div>
      {pinTooMany && <p role="alert" className="text-[12px] leading-4 text-danger">{t("keys.vps.pinTooMany", { pinned: pinSize(cpuset ?? ""), cores: cores })}</p>}
    </div>
  );
}

function AddServer({ hasDefault, hosts, defaults, disabled, adding, onAdd }: {
  hasDefault: boolean; hosts: string[]; defaults: Required<Pick<Limits, "memoryGb" | "cpus">>; disabled: boolean; adding: boolean;
  onAdd: (server: { name: string; alias: string } & Limits) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [memory, setMemory] = useState(String(MEMORY_GB.fallback));
  const [cpus, setCpus] = useState(String(CPUS.fallback));
  const [pin, setPin] = useState("");
  const memoryGb = limitValue(memory, MEMORY_GB);
  const cpuCount = limitValue(cpus, CPUS);
  const cpuset = pinValue(pin);
  const pinTooMany = tooManyPinned(cpuset, cpuCount ?? defaults.cpus);
  const canAdd = !disabled && Boolean(alias.trim()) && (!hasDefault || Boolean(name.trim())) && memoryGb !== null && cpuCount !== null && cpuset !== null && !pinTooMany;
  const add = () => {
    if (!canAdd || memoryGb === null || cpuCount === null || cpuset === null) return;
    onAdd({ name: name.trim(), alias: alias.trim(), memoryGb, cpus: cpuCount, cpuset })
      .then(() => { setName(""); setAlias(""); setMemory(String(MEMORY_GB.fallback)); setCpus(String(CPUS.fallback)); setPin(""); }, () => undefined);
  };
  const enter = (e: React.KeyboardEvent) => e.key === "Enter" && add();
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-hairline/40 bg-inset p-3.5">
      <div className="text-[13px] text-ink">{t("keys.vps.servers.addTitle")}</div>
      <div className={cn("grid gap-2.5", hasDefault ? "grid-cols-2" : "grid-cols-1")}>
        {hasDefault && (
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={enter} disabled={disabled} placeholder={t("keys.vps.servers.displayNamePlaceholder")} aria-label={t("keys.vps.servers.name")} autoComplete="off" className={KEY_FIELD} />
        )}
        {hosts.length > 0 ? (
          <Select data-key-input value={alias} onChange={(e) => setAlias(e.target.value)} disabled={disabled} aria-label={t("keys.vps.servers.alias")} className="w-full font-mono" size="sm">
            <option value="">{t("keys.vps.servers.aliasPlaceholder")}</option>
            {hosts.map((host) => <option key={host} value={host}>{host}</option>)}
          </Select>
        ) : (
          <input type="text" data-key-input value={alias} onChange={(e) => setAlias(e.target.value)} onKeyDown={enter} disabled={disabled} placeholder={t("keys.vps.servers.aliasPlaceholder")} aria-label={t("keys.vps.servers.alias")} autoComplete="off" spellCheck={false} className={cn(KEY_FIELD, "font-mono")} />
        )}
      </div>
      <div className={FIELDS}>
        <div className={cn("min-w-0 max-[480px]:flex-1", WIDTH.memory)}>
          <Stepper label={t("keys.vps.memory")} unit={t("keys.vps.unitGb")} value={memory} onChange={setMemory} range={MEMORY_GB} placeholder={String(defaults.memoryGb)} disabled={disabled} onEnter={add} />
        </div>
        <div className={cn("min-w-0 max-[480px]:flex-1", WIDTH.cpu)}>
          <Stepper label={t("keys.vps.cpus")} unit={t("keys.vps.unitCores")} value={cpus} onChange={setCpus} range={CPUS} placeholder={String(defaults.cpus)} disabled={disabled} onEnter={add} />
        </div>
        <div className={cn("min-w-0 max-[480px]:flex-1", WIDTH.pin)}>
          <PinInput value={pin} onChange={setPin} label={t("keys.vps.col.pin")} disabled={disabled} onEnter={add} tooMany={pinTooMany} />
        </div>
        <span className="flex-1" />
        <button type="button" onClick={add} disabled={!canAdd} className="ui-button ui-button-primary">
          {adding ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("keys.vps.servers.add")}
        </button>
      </div>
      {pinTooMany && <p role="alert" className="text-[12px] leading-4 text-danger">{t("keys.vps.pinTooMany", { pinned: pinSize(cpuset ?? ""), cores: cpuCount ?? defaults.cpus })}</p>}
    </div>
  );
}

/** The default server and the named ones as one list. Saving or deleting never moves a bot, except that bots following the default follow its replacement. */
export function VpsConnection() {
  const dispatch = useStoreDispatch();
  const named = useStoreSelector((s) => s.config?.vps?.servers ?? NO_SERVERS);
  const defaultAlias = useStoreSelector((s) => s.config?.vps?.sshAlias ?? "");
  const defaultMemory = useStoreSelector((s) => s.config?.vps?.memoryGb ?? MEMORY_GB.fallback);
  const defaultCpus = useStoreSelector((s) => s.config?.vps?.cpus ?? CPUS.fallback);
  const defaultCpuset = useStoreSelector((s) => s.config?.vps?.cpuset);
  const defaults = { memoryGb: defaultMemory, cpus: defaultCpus };
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [configHosts, setConfigHosts] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    serverFetch("/api/computers/vps/ssh-hosts", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((found: { hosts?: unknown } | null) => { if (alive && Array.isArray(found?.hosts)) setConfigHosts(found.hosts.filter((host): host is string => typeof host === "string")); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const servers: ServerEntry[] = [
    ...(defaultAlias ? [{ alias: defaultAlias, name: defaultAlias, isDefault: true, ...defaults, ...(defaultCpuset ? { cpuset: defaultCpuset } : {}) }] : []),
    ...named.map((server) => ({ alias: server.sshAlias, name: server.name, isDefault: false, memoryGb: server.memoryGb, cpus: server.cpus, cpuset: server.cpuset })),
  ];

  const put = (body: Record<string, unknown>, key: string): Promise<void> => {
    setBusy(key);
    setError(null);
    setNotice(null);
    return api("/api/config", { method: "PUT", body: JSON.stringify(body) })
      .then(({ notice: savedNotice, ...status }: ConfigStatus & { notice?: string }) => {
        dispatch({ type: "configStatus", config: status });
        setNotice(savedNotice ?? null);
      })
      .catch((e) => {
        setError(e.message);
        const failedNotice = (e as { body?: { notice?: unknown } }).body?.notice;
        if (typeof failedNotice === "string") setNotice(failedNotice);
        throw e;
      })
      .finally(() => setBusy(null));
  };
  const quiet = (work: Promise<void>) => work.catch(() => undefined);
  const limits = ({ memoryGb, cpus, cpuset }: Limits): Limits => ({
    ...(memoryGb === undefined ? {} : { memoryGb }),
    ...(cpus === undefined ? {} : { cpus }),
    ...(cpuset === undefined ? {} : { cpuset }),
  });

  const save = (server: ServerEntry, next: Limits) => {
    if (busy) return;
    if (server.isDefault) {
      return quiet(put({ vps: { sshAlias: server.alias, memoryGb: next.memoryGb, cpus: next.cpus, cpuset: next.cpuset ?? "" } }, `save:${server.alias}`));
    }
    const updated: NamedServer = { name: server.name, sshAlias: server.alias, ...limits(next) };
    return quiet(put({ vpsServers: named.map((entry) => (entry.sshAlias === server.alias ? updated : entry)) }, `save:${server.alias}`));
  };

  /** The default's name is its alias; a named server keeps its alias, which bots are tied to. */
  const rename = (server: ServerEntry, next: string) => {
    if (busy) return;
    if (server.isDefault) return quiet(put({ vps: { sshAlias: next } }, `save:${server.alias}`));
    return quiet(put({ vpsServers: named.map((entry) => (entry.sshAlias === server.alias ? { ...entry, name: next } : entry)) }, `save:${server.alias}`));
  };

  /** Deleting the default makes the next server the default; every server keeps the limits it had in effect. */
  const remove = (server: ServerEntry) => {
    if (busy) return;
    if (!server.isDefault) {
      return quiet(put({ vpsServers: named.filter((entry) => entry.sshAlias !== server.alias) }, server.alias));
    }
    const [next, ...rest] = named;
    if (!next) return quiet(put({ vps: { sshAlias: "" } }, server.alias));
    return quiet(put({
      vps: { sshAlias: next.sshAlias, memoryGb: next.memoryGb ?? defaults.memoryGb, cpus: next.cpus ?? defaults.cpus, cpuset: next.cpuset ?? "" },
      vpsServers: rest.map((entry) => ({ ...entry, memoryGb: entry.memoryGb ?? defaults.memoryGb, cpus: entry.cpus ?? defaults.cpus })),
    }, server.alias));
  };

  const add = (next: { name: string; alias: string } & Limits) => {
    if (!defaultAlias) return put({ vps: { sshAlias: next.alias, ...limits(next), cpuset: next.cpuset ?? "" } }, "");
    return put({ vpsServers: [...named, { name: next.name, sshAlias: next.alias, ...limits(next) }] }, "");
  };

  return (
    <div data-vps-connection className="flex max-w-[570px] flex-col gap-2">
      <p className="text-[12px] leading-4 text-ink-secondary">
        {t("keys.vps.descBefore")}
        <a href="https://github.com/milind-soni/OpenMausBot/blob/main/docs/byo-vps.md" target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">
          {t("keys.vps.descLink")}
        </a>
        {t("keys.vps.descAfter")}
      </p>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.anyMachine")}</p>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.servers.listHint")}</p>
      <div data-vps-servers className="flex flex-col gap-3.5 rounded-lg border border-hairline/40 bg-inset p-3.5">
        {servers.map((server, index) => (
          <div key={server.alias} className={cn(index > 0 && "border-t border-hairline/40 pt-3.5")}>
            <ServerCard
              server={server}
              defaults={defaults}
              busy={busy}
              disabled={busy !== null}
              onSave={(next) => save(server, next)}
              onRename={(next) => rename(server, next)}
              onRemove={() => remove(server)}
            />
          </div>
        ))}
        {servers.length > 0 && (
          <div className="flex flex-col gap-2">
            <button type="button" onClick={() => setDetails(!details)} aria-expanded={details} className="flex w-fit items-center gap-1 text-[12px] leading-4 text-ink-secondary hover:text-ink">
              <ChevronRight size={13} aria-hidden="true" className={cn("transition-transform motion-reduce:transition-none", details && "rotate-90")} />
              {t("keys.vps.details")}
            </button>
            {details && (
              <>
                <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.servers.greyHint")}</p>
                <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.resourcesHelp")}</p>
              </>
            )}
          </div>
        )}
      </div>
      <AddServer hasDefault={Boolean(defaultAlias)} hosts={configHosts.filter((host) => !servers.some((server) => server.alias === host))} defaults={defaults} disabled={busy !== null} adding={busy === ""} onAdd={add} />
      {notice && <div role="status" className="text-[12px] leading-4 text-ink-secondary">{notice}</div>}
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}
