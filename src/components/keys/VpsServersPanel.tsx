import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { useStoreSelector } from "@/state/store-select";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { KEY_FIELD } from "./KeyRow";
import { CPUS, Field, LimitField, limitValue, MEMORY_GB, useVpsSave, useVpsSaving, VpsServerEditor, type VpsNamedServer } from "./VpsServerEditor";

const NO_SERVERS: VpsNamedServer[] = [];
/** Not an alias (an alias starts with a letter or digit), so it never matches a server row. */
const ADDING_DEFAULT = "+default";

/** Non-secret Docker-over-SSH targets: the default server, then the named ones. Keys and passwords stay with SSH. */
export function VpsConnection() {
  const defaultAlias = useStoreSelector((s) => s.config?.vps?.sshAlias ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div data-vps-connection className="flex flex-col gap-2">
      <p className="text-[12px] leading-4 text-ink-secondary">
        {t("keys.vps.descBefore")}
        <a href="https://github.com/milind-soni/OpenMausBot/blob/main/docs/byo-vps.md" target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">
          {t("keys.vps.descLink")}
        </a>
        {t("keys.vps.descAfter")}
      </p>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.anyMachine")}</p>
      {defaultAlias ? <VpsServerEditor alias={defaultAlias} onRemoved={setNotice} hint={false} /> : <AddDefault onNotice={setNotice} />}
      {notice && <div role="status" className="text-[12px] leading-4 text-ink-secondary">{notice}</div>}
      <VpsServers />
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.limitsHint")}</p>
    </div>
  );
}

/** The first server becomes the default: only its SSH alias is asked for. */
function AddDefault({ onNotice }: { onNotice: (notice: string | null) => void }) {
  const save = useVpsSave();
  const saving = useVpsSaving();
  const [alias, setAlias] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    if (saving !== null || !alias.trim()) return;
    setError(null);
    save({ vps: { sshAlias: alias.trim() } }, ADDING_DEFAULT).then(onNotice, (e) => setError(e.message));
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          data-key-input
          value={alias}
          onChange={(e) => { setError(null); setAlias(e.target.value); }}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="my-vps"
          aria-label={t("keys.vps.aria")}
          autoComplete="off"
          spellCheck={false}
          className={cn(KEY_FIELD, "w-auto min-w-[min(100%,12rem)] flex-1")}
        />
        <button type="button" onClick={add} disabled={saving !== null || !alias.trim()} className="ui-button ui-button-primary shrink-0">
          {saving === ADDING_DEFAULT ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("common.save")}
        </button>
      </div>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </>
  );
}

/** Named servers a bot can be put on from its own settings. Saving the list never moves a bot. */
function VpsServers() {
  const servers = useStoreSelector((s) => s.config?.vps?.servers ?? NO_SERVERS);
  const inherited = useStoreSelector((s) => ({ memoryGb: s.config?.vps?.memoryGb ?? MEMORY_GB.fallback, cpus: s.config?.vps?.cpus ?? CPUS.fallback }), (a, b) => a.memoryGb === b.memoryGb && a.cpus === b.cpus);
  const save = useVpsSave();
  const saving = useVpsSaving();
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [memory, setMemory] = useState("");
  const [cpus, setCpus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const ids = { name: `${fieldId}-name`, alias: `${fieldId}-alias`, memory: `${fieldId}-memory`, cpus: `${fieldId}-cpus` };
  const memoryGb = limitValue(memory, MEMORY_GB);
  const cpuCount = limitValue(cpus, CPUS);
  const canAdd = saving === null && Boolean(name.trim()) && Boolean(alias.trim()) && memoryGb !== null && cpuCount !== null;

  const add = () => {
    if (!canAdd) return;
    setError(null);
    const server = { name: name.trim(), sshAlias: alias.trim(), ...(memoryGb === undefined ? {} : { memoryGb }), ...(cpuCount === undefined ? {} : { cpus: cpuCount }) };
    save({ vpsServers: [...servers, server] }, "")
      .then(() => { setName(""); setAlias(""); setMemory(""); setCpus(""); }, (e) => setError(e.message));
  };

  return (
    <div data-vps-servers className="mt-2 flex flex-col gap-2">
      <div className="text-[13px] text-ink">{t("keys.vps.servers.title")}</div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.vps.servers.hint")}</p>
      {servers.map((server) => <VpsServerEditor key={server.sshAlias} alias={server.sshAlias} hint={false} />)}
      <div data-vps-add="" role="group" aria-label={t("keys.vps.servers.add")} className="flex flex-col gap-3 @container/vps">
        <div className="grid grid-cols-1 gap-3 @min-[22rem]/vps:grid-cols-2">
          <Field id={ids.name} label={t("keys.vps.field.name")}>
            <input id={ids.name} type="text" value={name} onChange={(e) => { setError(null); setName(e.target.value); }} onKeyDown={(e) => e.key === "Enter" && add()}
              disabled={saving !== null} placeholder={t("keys.vps.servers.namePlaceholder")} autoComplete="off" className={KEY_FIELD} />
          </Field>
          <Field id={ids.alias} label={t("keys.vps.field.sshName")}>
            <input id={ids.alias} type="text" value={alias} onChange={(e) => { setError(null); setAlias(e.target.value); }} onKeyDown={(e) => e.key === "Enter" && add()}
              disabled={saving !== null} placeholder="home-lab" autoComplete="off" spellCheck={false} className={cn(KEY_FIELD, "font-mono")} />
          </Field>
          <Field id={ids.memory} label={t("keys.vps.field.memory")}>
            <LimitField id={ids.memory} value={memory} onChange={(next) => { setError(null); setMemory(next); }} range={MEMORY_GB} placeholder={inherited.memoryGb} disabled={saving !== null} onEnter={add} />
          </Field>
          <Field id={ids.cpus} label={t("keys.vps.field.cpus")}>
            <LimitField id={ids.cpus} value={cpus} onChange={(next) => { setError(null); setCpus(next); }} range={CPUS} placeholder={inherited.cpus} disabled={saving !== null} onEnter={add} />
          </Field>
        </div>
        <div>
          <button type="button" onClick={add} disabled={!canAdd} className="ui-button shrink-0">
            {saving === "" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("keys.vps.servers.add")}
          </button>
        </div>
      </div>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}
