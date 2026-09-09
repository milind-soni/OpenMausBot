// Engines settings — per-instance CLI path override. One "Set CLI…" button
// per engine reveals a picker: a "detected" dropdown of every binary the
// server found on PATH, plus a manual path input. Saving first probes the
// binary (`<cli> --version`, same PATH a real turn uses); a failed probe
// asks before registering — the classic miss is a path the terminal sees
// but this GUI app can't.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { EngineCard, EngineSections, RefreshEngines, engineReady } from "./EngineLibrary";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { EngineSetup, EngineUpdateNotice } from "./EngineSetup";
import { AddClaudeAccount, ClaudeAccountSettings } from "./ClaudeAccountSettings";
import { CodexAccountSettings } from "./CodexAccountSettings";

interface ProbeResult {
  ok: boolean;
  version?: string;
  message?: string;
}

function CustomPicker({ instance, cliDefault, onClose, onSaved }: {
  instance: InstanceInfo;
  cliDefault?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<string[] | null>(instance.cliCandidates ?? null);
  // `selected` starts EMPTY, never at instance.cli: a wrapper override
  // ("/ag claude agp") has no matching <option>, and a select whose value
  // points at a missing option renders the placeholder while still holding
  // the ghost value — the form would look empty yet refuse to save.
  const [selected, setSelected] = useState<string>("");
  const [manual, setManual] = useState<string>(
    // the current override rides the manual input unless it is exactly a
    // detected path (then the dropdown preselects it below)
    instance.cli && !(instance.cliCandidates ?? []).includes(instance.cli) ? instance.cli : "",
  );
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  // The describe() snapshot can be stale (CLI installed since last refresh);
  // re-fetch candidates once when the picker mounts so the dropdown is current.
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    api(`/api/cli-candidates?name=${encodeURIComponent(cliDefault ?? "")}`)
      .then(({ candidates: found }: { candidates: string[] }) => {
        setCandidates(found);
        if (!instance.cli) return;
        // preselect a detected override in the dropdown; a non-detected one
        // (wrapper string, moved binary) rides the manual input instead
        if (found.includes(instance.cli)) setSelected(instance.cli);
        else setManual(instance.cli);
      })
      .catch(() => setCandidates((prev) => prev ?? []));
  }, [cliDefault, instance.cli]);

  const value = manual.trim() || selected;
  const dirty = value !== (instance.cli ?? "");
  const busy = probing || saving;

  // Editing the path invalidates a previous probe result.
  useEffect(() => {
    setProbe(null);
  }, [value]);

  const persist = () => {
    if (busy || !value || !dirty) return;
    setSaving(true);
    setError(null);
    const committed = value; // freeze: inputs disable during save, but the
    // closure must not see a later keystroke either
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cli: committed }),
    })
      // onSaved (refreshInstances) failing must NOT read as "not saved" —
      // the PATCH already returned 200. Close regardless; the global banner
      // from refreshInstances already reports the refresh failure.
      .then(() => Promise.resolve(onSaved()).catch(() => {}))
      .then(onClose)
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const save = () => {
    if (busy || !value || !dirty) return;
    setProbing(true);
    setError(null);
    api("/api/cli-test", {
      method: "POST",
      body: JSON.stringify({ cli: value, driver: instance.driverKind }),
    })
      .then((result: ProbeResult) => {
        setProbe(result);
        // ok → save immediately; failed → hold for explicit confirmation
        if (result.ok) persist();
      })
      .catch((e) => setError(e.message))
      .finally(() => setProbing(false));
  };

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {candidates !== null && candidates.length > 0 && (
        <div className="relative">
          <select
            value={manual.trim() ? "" : selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setManual("");
            }}
            aria-label={t("engines.detectedAria", { name: instance.displayName })}
            disabled={busy}
            className="w-full appearance-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 pr-8 font-mono text-[12px] text-ink focus:border-hairline focus:outline-none disabled:opacity-50"
          >
            <option value="">{t("engines.selectBinary")}</option>
            {candidates.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
        </div>
      )}
      <input
        type="text"
        value={manual}
        onChange={(e) => setManual(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (!value || !dirty) return; // nothing to save — same hint the disabled button gives
          save();
        }}
        placeholder={candidates?.length ? t("engines.manualPath") : "/absolute/path/to/cli"}
        aria-label={t("engines.customAria", { name: instance.displayName })}
        spellCheck={false}
        disabled={busy}
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50"
      />
      {probe && !probe.ok && probe.message && (
        <div role="alert" className="flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-warning">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>{t("engines.testFailed", { message: probe.message })}</span>
        </div>
      )}
      {probe?.ok && probe.version && (
        <div className="text-[12px] text-success">{t("engines.testPassed", { version: probe.version })}</div>
      )}
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
        >
          {t("common.cancel")}
        </button>
        {probe && !probe.ok ? (
          <>
            <button
              onClick={() => setProbe(null)}
              disabled={busy}
              className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
            >
              {t("engines.editPath")}
            </button>
            <button
              onClick={() => persist()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-danger hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : t("engines.saveAnyway")}
            </button>
          </>
        ) : (
          <button
            onClick={save}
            disabled={busy || !value || !dirty}
            className={cn(
              "flex w-[72px] items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px]",
              "bg-raised text-ink hover:bg-raised-hover",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />{t("common.save")}</>}
          </button>
        )}
      </div>
    </div>
  );
}

function EngineRow({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updatedVersion, setUpdatedVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasOpenFor = useRef<string | null>(null);

  // Close the picker when this instance's override changes to anything else
  // — a save from this row, another tab, or the 5-min refresh. The picker
  // initialized its fields from the OLD value and never re-syncs, so staying
  // open would show stale state.
  useEffect(() => {
    if (wasOpenFor.current !== null && wasOpenFor.current !== instance.cli) {
      setOpen(false);
    }
    wasOpenFor.current = instance.cli ?? null;
  }, [instance.cli]);

  const reset = () => {
    if (switching || updating) return;
    setSwitching(true);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cli: "" }),
    })
      // The reset already succeeded once PATCH returns 200. A follow-up list
      // refresh failure should not tell the user the reset itself failed.
      .then(() => Promise.resolve(refreshInstances()).catch(() => {}))
      .catch((e) => setError(e.message))
      .finally(() => setSwitching(false));
  };

  const updateClaude = () => {
    if (switching || updating) return;
    setUpdating(true);
    setUpdatedVersion(null);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}/claude-update`, {
      method: "POST",
      body: JSON.stringify({}),
    })
      .then(async ({ version }: { version: string }) => {
        setUpdatedVersion(version);
        await Promise.resolve(refreshInstances()).catch(() => {});
      })
      .catch((e) => setError(e.message))
      .finally(() => setUpdating(false));
  };

  return (
    <EngineCard instance={instance}>
      {!engineReady(instance) && <EngineSetup instance={instance} intent={instance.access === "custom" ? "inject" : "cloud"} unframed />}
      {instance.snapshot.update && <EngineUpdateNotice update={instance.snapshot.update} instance={instance} className="mt-3" />}
      {instance.claudeAccount && <ClaudeAccountSettings instance={instance} />}
      {engineReady(instance) && instance.snapshot.authenticated === true && (
        instance.authentication?.method === "device-code"
          ? <CodexAccountSettings instance={instance} />
          : instance.authentication?.method === "paste-code" && !instance.claudeAccount && (
            <p className="flex items-center gap-1.5 text-[12px] text-success"><Check size={13} />{t("engineSetup.claude.connectedAccount")}</p>
          )
      )}
      <details className="mt-3 rounded-xl border border-hairline/40 px-3 py-2.5">
        <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary hover:text-ink">{t("engines.library.advanced")}</summary>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("engines.footer")}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
          {instance.cli ? (
            <span className="w-full break-all font-mono text-[11.5px] text-ink-secondary" title={instance.cli}>
              {instance.cli}
            </span>
          ) : (
            instance.cliDefault && (
              <span className="break-all font-mono text-[11px] text-ink-secondary">{instance.cliDefault}</span>
            )
          )}
          {instance.snapshot.version && (
            <span className="break-all text-[11px] text-ink-secondary" title={instance.snapshot.version}>
              {instance.snapshot.version}
            </span>
          )}
          <span className="flex-1" />
          {instance.driverKind === "claudeAgent" && (
            <button
              onClick={updateClaude}
              disabled={switching || updating}
              className="flex shrink-0 items-center gap-1 text-[11.5px] text-ink-secondary hover:text-ink disabled:opacity-50"
            >
              {updating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {updating ? t("engines.updating") : t("engines.updateClaude")}
            </button>
          )}
          {instance.cli && (
            <button
              onClick={reset}
              disabled={switching || updating}
              className="shrink-0 text-[11.5px] text-ink-secondary hover:text-ink disabled:opacity-50"
            >
              {switching ? t("engines.resetting") : t("engines.reset")}
            </button>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            disabled={updating}
            aria-expanded={open}
            className={cn(
              "shrink-0 rounded-lg border border-hairline/40 px-3 py-1 text-[12px]",
              open ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
              "disabled:opacity-50",
            )}
          >
            {t("engines.setCli")}
          </button>
        </div>
        {updatedVersion && (
          <div role="status" className="mt-1 text-[12px] text-success">{t("engines.claudeUpdated", { version: updatedVersion })}</div>
        )}
        {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
        {open && (
          <CustomPicker
            instance={instance}
            cliDefault={instance.cliDefault}
            onClose={() => setOpen(false)}
            onSaved={refreshInstances}
          />
        )}
      </details>
    </EngineCard>
  );
}

export function EnginesSettings() {
  const { state } = useStore();
  // every KNOWN-driver instance has cliDefault; unknown-driver shadows have
  // neither unless an override was set. Including them keeps a Reset-able row
  // (and a Set CLI… path) for engines the running build doesn't recognize.
  const rows = state.instances.filter((i) => i.cli !== undefined || i.cliDefault !== undefined || i.snapshot.state === "unavailable");

  return (
    <div className="flex min-w-0 flex-col gap-6 pb-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{t("settings.engines.title")}</h1>
          <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-ink-secondary">{t("engines.library.intro")}</p>
        </div>
        <RefreshEngines />
      </div>
      <EngineSections instances={rows} renderEngine={(instance) => <EngineRow instance={instance} />} />
      <div className="border-t border-hairline/40 pt-4"><AddClaudeAccount /></div>
    </div>
  );
}
