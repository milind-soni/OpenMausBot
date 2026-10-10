// Settings → Decision model. One master switch, the Jev key (write-only:
// the server reports configured-or-not, never the value), and one switch per
// thing it decides. Saving a key turns it on; there is no confirm step. The
// packaged desktop keeps the key in its OS-encrypted store; elsewhere it goes
// to the server's own 0600 config, like every other workspace key. On a Cloud
// Pro home Jev is included: it works with no key, there is nothing to clear,
// and a key pasted here replaces it.
import { useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";

const KEY_URL = "https://typesafe.ai";

type TestResult = { ok: true; latencyMs: number } | { ok: false; reason: string; status?: number };

const FAILURES: Record<string, LocaleKey> = {
  rejected: "decider.error.rejected",
  unreachable: "decider.error.unreachable",
  timeout: "decider.error.timeout",
  rate_limited: "decider.error.rateLimited",
  overloaded: "decider.error.overloaded",
  malformed: "decider.error.malformed",
  no_key: "decider.error.noKey",
  misconfigured: "decider.error.misconfigured",
};

/** A test of Cloud Pro's included decisions has no key to check at
 * typesafe.ai: its relay refuses a subscription that is not active (402) and
 * a month's decisions that are used up (429). */
const INCLUDED_FAILURES: Record<string, LocaleKey> = {
  rejected: "decider.included.error.rejected",
  rate_limited: "decider.included.error.limited",
};

/** A fixed sentence per failure: the vendor's own body never reaches the UI. */
export function deciderFailureText(result: { reason: string; status?: number }, included = false): string {
  if (included && result.reason === "http_error" && result.status === 402) return t("decider.included.error.subscription");
  if (included && INCLUDED_FAILURES[result.reason]) return t(INCLUDED_FAILURES[result.reason]!);
  if (result.reason === "http_error") return t("decider.error.http", { status: String(result.status ?? "?") });
  const key = FAILURES[result.reason];
  return key ? t(key) : t("decider.error.other");
}

/** Jobs that are not built yet: listed so people know what is coming, with
 * no switch, because a switch that does nothing would be a lie. */
const COMING_SOON: LocaleKey[] = ["decider.jobs.browserClicks", "decider.jobs.toolSelection", "decider.jobs.placement"];

export function DecisionModelSettings() {
  const { state, dispatch } = useStore();
  const decider = state.config?.decider;
  const configured = decider?.configured ?? false;
  // Cloud Pro's decisions, with no key saved: nothing to clear or replace.
  const included = configured && decider?.included === true;
  const ownKey = configured && !included;
  const enabled = decider?.enabled ?? false;
  const roomRouting = decider?.jobs.roomRouting ?? true;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const draft = value.trim();
  const clearing = !draft && ownKey;

  const applied = (config: ConfigStatus) => dispatch({ type: "configStatus", config });

  const patch = async (decision: Record<string, unknown>) => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      applied(await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: decision }) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSwitching(false);
    }
  };

  const save = async () => {
    if (saving || (!draft && !ownKey)) return;
    setSaving(true);
    setError(null);
    setVerdict(null);
    try {
      const status = window.ogb?.setCredential
        ? await window.ogb.setCredential("jevApiKey", draft)
        : await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: { key: draft } }) });
      applied(status);
      setValue("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (testing || saving || (!draft && !configured)) return;
    setTesting(true);
    setVerdict(null);
    setError(null);
    // With no draft, the server tests what is in use: Cloud Pro's included
    // decisions go through the Admin's relay, never to Jev directly.
    const testingIncluded = !draft && included;
    try {
      const result = await api<TestResult>("/api/decider/test", { method: "POST", body: JSON.stringify(draft ? { key: draft } : {}) });
      setVerdict(result.ok
        ? { ok: true, text: t("decider.test.ok", { ms: String(result.latencyMs) }) }
        : { ok: false, text: deciderFailureText(result, testingIncluded) });
    } catch (cause) {
      setVerdict({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("decider.intro")}</p>
      <div>
        <SettingRow title={t("decider.master")} subtitle={configured ? undefined : t("decider.masterNeedsKey")}>
          <Switch
            data-testid="decider-master"
            aria-label={t("decider.master")}
            checked={enabled}
            disabled={!configured || switching || !state.config}
            onClick={() => void patch({ enabled: !enabled })}
            className="cursor-pointer"
          />
        </SettingRow>
      </div>

      <Card title={t("decider.key.label")}>
        <div role="status" className="mb-2 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
          <span className={configured ? "text-success" : undefined}>
            {included ? t("keys.includedWithCloudPro") : configured ? t("decider.status.connected") : t("decider.status.notConnected")}
          </span>
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={value}
            onChange={(event) => { setVerdict(null); setError(null); setValue(event.target.value); }}
            onKeyDown={(event) => event.key === "Enter" && void save()}
            disabled={saving}
            placeholder={ownKey ? t("keys.replace") : t("decider.key.placeholder")}
            aria-label={t("decider.key.label")}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <button
            type="button"
            data-testid="decider-save"
            onClick={() => void save()}
            disabled={saving || (!draft && !ownKey)}
            title={clearing ? t("keys.removeKey") : t("common.save")}
            className={cn(
              "flex w-[72px] shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50",
              clearing ? "text-danger" : "text-ink",
            )}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? t("keys.clear") : <><Check size={13} />{t("common.save")}</>}
          </button>
          <button
            type="button"
            data-testid="decider-test"
            onClick={() => void test()}
            disabled={testing || saving || (!draft && !configured)}
            className="flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? t("keys.testing") : t("keys.test")}
          </button>
        </div>
        {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
        {verdict && <p role="status" className={cn("mt-1 text-[12px]", verdict.ok ? "text-success" : "text-danger")}>{verdict.text}</p>}
        <a
          href={KEY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex cursor-pointer items-center gap-1 text-[12px] text-accent hover:underline"
        >
          {t("decider.key.getKey")}
          <ExternalLink size={11} aria-hidden="true" />
        </a>
      </Card>

      <Card title={t("decider.jobs.title")}>
        <ul className="flex flex-col">
          <li className="flex items-start justify-between gap-4 py-2">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">{t("decider.jobs.roomRouting")}</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("decider.jobs.roomRoutingDetail")}</div>
            </div>
            <Switch
              data-testid="decider-job-roomRouting"
              aria-label={t("decider.jobs.roomRouting")}
              checked={enabled && roomRouting}
              disabled={!enabled || switching}
              onClick={() => void patch({ jobs: { roomRouting: !roomRouting } })}
              className="cursor-pointer"
            />
          </li>
          {COMING_SOON.map((label) => (
            <li key={label} data-testid="decider-coming-soon" aria-disabled="true" className="flex items-center justify-between gap-4 border-t border-hairline/40 py-2 opacity-50">
              <span className="text-[13px] text-ink-secondary">{t(label)}</span>
              <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
                {t("decider.jobs.comingSoon")}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
