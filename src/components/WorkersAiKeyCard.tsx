// The person's own Cloudflare Workers AI key: an account ID (not a secret, shown back) and a write-only token. With it,
// Clef decides and Clairic reads, and the free tier covers light use.
import { useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { SETTINGS_INPUT, SettingsField, SettingsFormFoot, SettingsGroup, SettingsRows, StatusDot } from "./SettingsPrimitives";

const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

type TestResult = { ok: true; latencyMs: number; extraction?: { ok: boolean } } | { ok: false; reason: string; status?: number; extraction?: { ok: boolean } };

export function WorkersAiKeyCard({ failureText }: { failureText: (result: { reason: string; status?: number }) => string }) {
  const { state, dispatch } = useStore();
  const helpers = state.config?.helpers;
  const saved = helpers?.own.workersAi === true;
  const savedAccount = helpers?.workersAiAccountId ?? "";
  const [account, setAccount] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const accountId = (account ?? savedAccount).trim();
  const draft = token.trim();
  const clearing = !draft && saved && account === null;
  const accountChanged = account !== null && accountId !== savedAccount;

  const applied = (config: ConfigStatus) => dispatch({ type: "configStatus", config });

  const save = async () => {
    if (saving || (!draft && !saved && !accountChanged)) return;
    if (draft && !ACCOUNT_ID.test(accountId)) return setError(t("decider.workersAi.needsAccount"));
    setSaving(true);
    setError(null);
    setVerdict(null);
    try {
      // The account ID first: the token's check on save needs it.
      if (accountChanged || (draft && !savedAccount)) {
        applied(await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: { workersAiAccountId: accountId } }) }));
      }
      if (draft || clearing) {
        applied(window.ogb?.setCredential
          ? await window.ogb.setCredential("workersAiToken", draft)
          : await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: { workersAiToken: draft } }) }));
      }
      setToken("");
      setAccount(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (testing || saving || (!draft && !saved)) return;
    setTesting(true);
    setVerdict(null);
    setError(null);
    try {
      const result = await api<TestResult>("/api/decider/test", {
        method: "POST",
        body: JSON.stringify({ provider: "workersai", ...(draft ? { key: draft, accountId } : {}) }),
      });
      const extraction = result.extraction ? [t(result.extraction.ok ? "decider.test.extractionOk" : "decider.test.extractionFailed")] : [];
      setVerdict(result.ok
        ? { ok: result.extraction?.ok !== false, text: [t("decider.workersAi.test.ok", { ms: String(result.latencyMs) }), ...extraction].join(" ") }
        : { ok: false, text: failureText(result) });
    } catch (cause) {
      setVerdict({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsGroup label={t("decider.workersAi.title")} description={t("decider.workersAi.detail")} block="workers-ai">
      <SettingsRows>
        <div className="flex flex-col gap-3 px-4 pb-1 pt-3">
          <SettingsField label={t("decider.workersAi.accountId")}>
            <input
              type="text"
              data-testid="workers-ai-account"
              value={account ?? savedAccount}
              onChange={(event) => { setVerdict(null); setError(null); setAccount(event.target.value); }}
              disabled={saving}
              placeholder={t("decider.workersAi.accountIdPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              className={SETTINGS_INPUT}
            />
          </SettingsField>
          <SettingsField label={t("decider.workersAi.token")}>
            <input
              type="password"
              data-testid="workers-ai-token"
              value={token}
              onChange={(event) => { setVerdict(null); setError(null); setToken(event.target.value); }}
              onKeyDown={(event) => event.key === "Enter" && void save()}
              disabled={saving}
              placeholder={saved ? t("keys.replace") : t("decider.workersAi.tokenPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              className={SETTINGS_INPUT}
            />
          </SettingsField>
          <p className="text-[13px] leading-[18px] text-ink-secondary">
            <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer" className="cursor-pointer text-accent-text hover:underline focus-visible:underline">{t("decider.workersAi.getKey")}</a>
          </p>
        </div>
        <SettingsFormFoot status={<span className="flex flex-col gap-1">
          <span role="status" className="flex items-center">{saved ? <StatusDot tone="success" /> : <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-ink/20" />}{t(saved ? "decider.status.connected" : "decider.status.notSetUpShort")}</span>
          {error && <span role="alert" className="text-danger">{error}</span>}
          {verdict && <span role="status" className={verdict.ok ? "text-ink-secondary" : "text-danger"}>{verdict.text}</span>}
        </span>}>
          <button type="button" data-testid="workers-ai-test" onClick={() => void test()} disabled={testing || saving || (!draft && !saved)}
            className="ui-button ui-button-md cursor-pointer rounded-full">{testing ? t("keys.testing") : t("keys.test")}</button>
          <button type="button" data-testid="workers-ai-save" onClick={() => void save()} disabled={saving || (!draft && !saved && !accountChanged)}
            title={clearing ? t("keys.removeKey") : t("common.save")} className={cn("ui-button ui-button-md cursor-pointer rounded-full", clearing && "!text-danger")}>
            {saving ? t("settings.threads.saving") : clearing ? t("keys.clear") : t("common.save")}
          </button>
        </SettingsFormFoot>
      </SettingsRows>
    </SettingsGroup>
  );
}
