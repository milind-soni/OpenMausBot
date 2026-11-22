import { useEffect, useRef, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Switch } from "../SettingsPrimitives";
import { KEY_FIELD } from "./KeyRow";
import { cleanKey, looksLikeKey } from "./key-save";

/** Security: write-only; the server returns names, never keys, and hands the keys to OpenCode alone. */
export function OpenCodeProviderKeys() {
  const { state, dispatch } = useStore();
  const names = state.config?.opencodeGo?.providerKeys ?? [];
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = adding || removing !== null;

  const put = (target: string, value: string) =>
    api("/api/config", { method: "PUT", body: JSON.stringify({ opencodeGo: { providerKeys: { [target]: value } } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }));

  const add = () => {
    const target = name.trim().toUpperCase();
    const value = cleanKey(key);
    if (busy || !target || !value) return;
    if (!looksLikeKey(value)) {
      setError(t("keys.notAKey"));
      return;
    }
    setAdding(true);
    setError(null);
    put(target, value)
      .then(() => { setName(""); setKey(""); })
      .catch((e) => setError(e.message))
      .finally(() => setAdding(false));
  };

  const remove = (target: string) => {
    if (busy) return;
    setRemoving(target);
    setError(null);
    put(target, "")
      .catch((e) => setError(e.message))
      .finally(() => setRemoving(null));
  };

  return (
    <div data-opencode-provider-keys className="flex flex-col gap-2">
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.opencode.otherProviders.hint")}</p>
      {state.config?.cloudHome !== true && (
        <p className="text-[12px] leading-4 text-ink-secondary">
          {t("keys.opencode.providersHint").split("{command}").flatMap((part, index) =>
            index === 0 ? [part] : [<code key={index} className="font-mono">opencode auth login</code>, part])}
        </p>
      )}
      {names.map((saved) => (
        <div key={saved} data-opencode-provider-key={saved} className="flex flex-wrap items-center gap-2">
          <span className={cn(KEY_FIELD, "block flex-1 truncate text-ink")}>{saved}</span>
          <button
            type="button"
            onClick={() => remove(saved)}
            disabled={busy}
            aria-label={t("keys.opencode.otherProviders.removeAria", { name: saved })}
            className="ui-button shrink-0"
          >
            {removing === saved ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("keys.row.remove")}
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => { setError(null); setName(e.target.value); }}
          onKeyDown={(e) => e.key === "Enter" && add()}
          disabled={busy}
          placeholder="VENICE_API_KEY"
          aria-label={t("keys.opencode.otherProviders.name")}
          autoComplete="off"
          spellCheck={false}
          className={cn(KEY_FIELD, "w-auto min-w-[min(100%,10rem)] flex-1 uppercase placeholder:normal-case")}
        />
        <input
          type="password"
          value={key}
          onChange={(e) => { setError(null); setKey(e.target.value); }}
          onKeyDown={(e) => e.key === "Enter" && add()}
          disabled={busy}
          placeholder={t("keys.opencode.otherProviders.keyPlaceholder")}
          aria-label={t("keys.opencode.otherProviders.key")}
          autoComplete="off"
          className={cn(KEY_FIELD, "w-auto min-w-[min(100%,10rem)] flex-1")}
        />
        <button type="button" onClick={add} disabled={busy || !name.trim() || !key.trim()} className="ui-button shrink-0">
          {adding ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("common.save")}
        </button>
      </div>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

export function AnthropicEveryClaudeBot() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state.config?.anthropic?.configured) return null;
  const on = state.config.anthropic.everyClaudeBot === true;
  const toggle = () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ anthropic: { everyClaudeBot: !on } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };
  return (
    <div data-anthropic-every-claude-bot className="flex flex-col gap-1.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-[18px] text-ink">{t("keys.anthropic.everyBot")}</div>
          <div className="text-[12px] leading-4 text-ink-secondary">{on ? t("keys.anthropic.everyBotOn") : t("keys.anthropic.everyBotOff")}</div>
        </div>
        <Switch checked={on} disabled={saving} onClick={toggle} aria-label={t("keys.anthropic.everyBot")} />
      </div>
      {on && (
        <p className="flex gap-1.5 text-[12px] leading-4 text-warning">
          <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
          <span>{t("keys.anthropic.warning")}</span>
        </p>
      )}
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

/** Non-secret Docker-over-SSH target. Keys and passwords stay with SSH. */
export function VpsConnection() {
  const { state, dispatch } = useStore();
  const [alias, setAlias] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const configured = Boolean(state.config?.vps?.configured);
  const clearing = !alias.trim() && configured;
  const unchanged = alias.trim() === (state.config?.vps?.sshAlias ?? "");

  useEffect(() => {
    setAlias(state.config?.vps?.sshAlias ?? "");
  }, [state.config?.vps?.sshAlias]);

  const save = () => {
    if (saving || (!alias.trim() && !configured) || unchanged) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ vps: { sshAlias: alias.trim() } }) })
      .then(({ notice: savedNotice, ...status }: ConfigStatus & { notice?: string }) => {
        dispatch({ type: "configStatus", config: status });
        setAlias(status.vps?.sshAlias ?? "");
        setNotice(savedNotice ?? null);
      })
      .catch((e) => {
        setError(e.message);
        // A save that failed after the alias changed still says what the old server may hold.
        const failedNotice = (e as { body?: { notice?: unknown } }).body?.notice;
        if (typeof failedNotice === "string") setNotice(failedNotice);
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] leading-4 text-ink-secondary">
        {t("keys.vps.descBefore")}
        <a href="https://github.com/milind-soni/OpenMausBot/blob/main/docs/byo-vps.md" target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">
          {t("keys.vps.descLink")}
        </a>
        {t("keys.vps.descAfter")}
      </p>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.anyMachine")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          data-key-input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="my-vps"
          aria-label={t("keys.vps.aria")}
          autoComplete="off"
          spellCheck={false}
          className={cn(KEY_FIELD, "w-auto min-w-[min(100%,12rem)] flex-1")}
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || (!alias.trim() && !configured) || unchanged}
          className={cn("ui-button shrink-0", !clearing && "ui-button-primary")}
          title={clearing ? t("keys.vps.removeAlias") : undefined}
        >
          {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : clearing ? t("keys.row.remove") : t("common.save")}
        </button>
      </div>
      {configured && <VpsResources />}
      {notice && <div role="status" className="text-[12px] leading-4 text-ink-secondary">{notice}</div>}
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
      <VpsServers />
    </div>
  );
}

const NO_SERVERS: { name: string; sshAlias: string }[] = [];

type NamedServer = NonNullable<ConfigStatus["vps"]["servers"]>[number];

const VPS_MEMORY_GB = { min: 2, max: 128, fallback: 4 };
const VPS_CPUS = { min: 1, max: 64, fallback: 2 };

/** Empty is "not set"; anything else must be a whole number in range. */
function limitValue(text: string, range: { min: number; max: number }): number | undefined | null {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= range.min && n <= range.max ? n : null;
}

function LimitInput({ label, value, onChange, range, placeholder, disabled }: {
  label: string; value: string; onChange: (value: string) => void; range: { min: number; max: number }; placeholder: string; disabled: boolean;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={range.min}
      max={range.max}
      step={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={limitValue(value, range) === null}
      className={cn(KEY_FIELD, "w-20")}
    />
  );
}

/** One saved server with its own limits; empty fields use the default server's. */
function VpsServerRow({ server, busy, disabled, onSave, onRemove, defaults }: {
  server: NamedServer; busy: boolean; disabled: boolean; onSave: (next: NamedServer) => void; onRemove: () => void; defaults: { memoryGb: number; cpus: number };
}) {
  const [memory, setMemory] = useState(server.memoryGb === undefined ? "" : String(server.memoryGb));
  const [cpus, setCpus] = useState(server.cpus === undefined ? "" : String(server.cpus));
  useEffect(() => {
    setMemory(server.memoryGb === undefined ? "" : String(server.memoryGb));
    setCpus(server.cpus === undefined ? "" : String(server.cpus));
  }, [server.memoryGb, server.cpus]);
  const memoryGb = limitValue(memory, VPS_MEMORY_GB);
  const cpuCount = limitValue(cpus, VPS_CPUS);
  const valid = memoryGb !== null && cpuCount !== null;
  const dirty = memoryGb !== server.memoryGb || cpuCount !== server.cpus;
  const save = () => {
    if (!valid || !dirty) return;
    const { memoryGb: _memory, cpus: _cpus, ...rest } = server;
    onSave({ ...rest, ...(memoryGb === undefined ? {} : { memoryGb }), ...(cpuCount === undefined ? {} : { cpus: cpuCount }) });
  };
  return (
    <div data-vps-server={server.sshAlias} className="flex flex-wrap items-center gap-2">
      <span className={cn(KEY_FIELD, "block flex-1 truncate text-ink")}>
        {server.name} <span className="font-mono text-ink-secondary">{server.sshAlias}</span>
      </span>
      <LimitInput label={t("keys.vps.memory")} value={memory} onChange={setMemory} range={VPS_MEMORY_GB} placeholder={String(defaults.memoryGb)} disabled={disabled} />
      <LimitInput label={t("keys.vps.cpus")} value={cpus} onChange={setCpus} range={VPS_CPUS} placeholder={String(defaults.cpus)} disabled={disabled} />
      <button type="button" onClick={save} disabled={disabled || !valid || !dirty} className="ui-button ui-button-primary shrink-0">
        {t("common.save")}
      </button>
      <button type="button" onClick={onRemove} disabled={disabled} aria-label={t("keys.vps.servers.removeAria", { name: server.name })} className="ui-button shrink-0">
        {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("keys.row.remove")}
      </button>
    </div>
  );
}

/** Named servers a bot can be put on from its own settings. Saving the list never moves a bot. */
function VpsServers() {
  const servers = useStoreSelector((s) => s.config?.vps?.servers ?? NO_SERVERS);
  const defaultMemory = useStoreSelector((s) => s.config?.vps?.memoryGb ?? VPS_MEMORY_GB.fallback);
  const defaultCpus = useStoreSelector((s) => s.config?.vps?.cpus ?? VPS_CPUS.fallback);
  const dispatch = useStoreDispatch();
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [memory, setMemory] = useState("");
  const [cpus, setCpus] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const defaults = { memoryGb: defaultMemory, cpus: defaultCpus };
  const newMemory = limitValue(memory, VPS_MEMORY_GB);
  const newCpus = limitValue(cpus, VPS_CPUS);
  const canAdd = saving === null && Boolean(name.trim()) && Boolean(alias.trim()) && newMemory !== null && newCpus !== null;

  const put = (next: NamedServer[], busy: string) => {
    setSaving(busy);
    setError(null);
    return api("/api/config", { method: "PUT", body: JSON.stringify({ vpsServers: next }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .finally(() => setSaving(null));
  };
  const add = () => {
    if (!canAdd) return;
    const added: NamedServer = { name: name.trim(), sshAlias: alias.trim(), ...(newMemory === undefined || newMemory === null ? {} : { memoryGb: newMemory }), ...(newCpus === undefined || newCpus === null ? {} : { cpus: newCpus }) };
    put([...servers, added], "")
      .then(() => { setName(""); setAlias(""); setMemory(""); setCpus(""); })
      .catch((e) => setError(e.message));
  };
  const replace = (target: string, next: NamedServer) => {
    if (saving) return;
    put(servers.map((server) => (server.sshAlias === target ? next : server)), `save:${target}`).catch((e) => setError(e.message));
  };
  const remove = (target: string) => {
    if (saving) return;
    put(servers.filter((server) => server.sshAlias !== target), target).catch((e) => setError(e.message));
  };

  return (
    <div data-vps-servers className="mt-2 flex flex-col gap-2">
      <div className="text-[13px] text-ink">{t("keys.vps.servers.title")}</div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.servers.hint")}</p>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.servers.limitsHint")}</p>
      {servers.map((server) => (
        <VpsServerRow
          key={server.sshAlias}
          server={server}
          busy={saving === server.sshAlias}
          disabled={saving !== null}
          defaults={defaults}
          onSave={(next) => replace(server.sshAlias, next)}
          onRemove={() => remove(server.sshAlias)}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => { setError(null); setName(e.target.value); }}
          onKeyDown={(e) => e.key === "Enter" && add()}
          disabled={saving !== null}
          placeholder={t("keys.vps.servers.namePlaceholder")}
          aria-label={t("keys.vps.servers.name")}
          autoComplete="off"
          className={cn(KEY_FIELD, "w-auto min-w-[min(100%,10rem)] flex-1")}
        />
        <input
          type="text"
          value={alias}
          onChange={(e) => { setError(null); setAlias(e.target.value); }}
          onKeyDown={(e) => e.key === "Enter" && add()}
          disabled={saving !== null}
          placeholder="home-lab"
          aria-label={t("keys.vps.servers.alias")}
          autoComplete="off"
          spellCheck={false}
          className={cn(KEY_FIELD, "w-auto min-w-[min(100%,10rem)] flex-1 font-mono")}
        />
        <LimitInput label={t("keys.vps.memory")} value={memory} onChange={setMemory} range={VPS_MEMORY_GB} placeholder={String(defaultMemory)} disabled={saving !== null} />
        <LimitInput label={t("keys.vps.cpus")} value={cpus} onChange={setCpus} range={VPS_CPUS} placeholder={String(defaultCpus)} disabled={saving !== null} />
        <button type="button" onClick={add} disabled={!canAdd} className="ui-button shrink-0">
          {saving === "" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("keys.vps.servers.add")}
        </button>
      </div>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

/** What each bot's VPS desktop may use; the host's own capacity is the real ceiling. */
function VpsResources() {
  const { state, dispatch } = useStore();
  const savedMemory = state.config?.vps?.memoryGb ?? VPS_MEMORY_GB.fallback;
  const savedCpus = state.config?.vps?.cpus ?? VPS_CPUS.fallback;
  const [memory, setMemory] = useState(String(savedMemory));
  const [cpus, setCpus] = useState(String(savedCpus));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setMemory(String(savedMemory)); setCpus(String(savedCpus)); }, [savedMemory, savedCpus]);
  const whole = (value: string, range: { min: number; max: number }) => {
    const n = Number(value);
    return value.trim() !== "" && Number.isInteger(n) && n >= range.min && n <= range.max ? n : null;
  };
  const memoryGb = whole(memory, VPS_MEMORY_GB);
  const cpuCount = whole(cpus, VPS_CPUS);
  const dirty = memoryGb !== savedMemory || cpuCount !== savedCpus;
  const save = () => {
    if (saving || memoryGb === null || cpuCount === null || !dirty) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ vps: { sshAlias: state.config?.vps?.sshAlias ?? "", memoryGb, cpus: cpuCount } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };
  const field = (label: string, value: string, set: (v: string) => void, range: { min: number; max: number }) => (
    <label className="flex items-center gap-2 text-[12px] leading-4 text-ink-secondary">
      {label}
      <input
        type="number"
        inputMode="numeric"
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
        aria-invalid={whole(value, range) === null}
        className={cn(KEY_FIELD, "w-20")}
      />
    </label>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        {field(t("keys.vps.memory"), memory, setMemory, VPS_MEMORY_GB)}
        {field(t("keys.vps.cpus"), cpus, setCpus, VPS_CPUS)}
        <button type="button" onClick={save} disabled={saving || memoryGb === null || cpuCount === null || !dirty} className="ui-button ui-button-primary shrink-0">
          {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("common.save")}
        </button>
      </div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.resourcesHelp")}</p>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

export function OpenAiCompatUrl() {
  const { state, dispatch } = useStore();
  const saved = state.config?.openaiCompat?.url ?? "";
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  useEffect(() => { setValue(saved); }, [saved]);
  const dirty = value.trim() !== saved;

  const save = () => {
    if (savingRef.current || !dirty) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ openaiCompat: { url: value.trim() } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => { savingRef.current = false; setSaving(false); });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[13px] leading-[18px] text-ink">{t("keys.openaiCompat.url")}</div>
      <div className="relative">
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="https://api.groq.com/openai/v1"
          aria-label={t("keys.openaiCompat.url")}
          spellCheck={false}
          className={cn(KEY_FIELD, "pr-8")}
        />
        {saving && <Loader2 size={13} aria-hidden="true" className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-ink-secondary" />}
      </div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.openaiCompat.urlHint")}</p>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}
