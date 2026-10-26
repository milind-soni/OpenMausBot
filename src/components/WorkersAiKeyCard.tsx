// The person's own Cloudflare Workers AI key: an account ID (not a secret, shown back) and a write-only token. With it,
// Clef decides and Clairic reads, and the free tier covers light use.
import { useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Card } from "./SettingsPrimitives";

const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const FIELD = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none";

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
    <Card title={t("decider.workersAi.title")}>
      <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">{t("decider.workersAi.detail")}</p>
      {saved && (
        <div role="status" className="mb-2 flex items-center gap-2 text-[13px] text-success">
          <span className="size-1.5 rounded-full bg-success" />
          <span>{t("decider.status.connected")}</span>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <input
          type="text"
          data-testid="workers-ai-account"
          value={account ?? savedAccount}
          onChange={(event) => { setVerdict(null); setError(null); setAccount(event.target.value); }}
          disabled={saving}
          placeholder={t("decider.workersAi.accountIdPlaceholder")}
          aria-label={t("decider.workersAi.accountId")}
          autoComplete="off"
          spellCheck={false}
          className={FIELD}
        />
        <div className="flex gap-2">
          <input
            type="password"
            data-testid="workers-ai-token"
            value={token}
            onChange={(event) => { setVerdict(null); setError(null); setToken(event.target.value); }}
            onKeyDown={(event) => event.key === "Enter" && void save()}
            disabled={saving}
            placeholder={saved ? t("keys.replace") : t("decider.workersAi.tokenPlaceholder")}
            aria-label={t("decider.workersAi.token")}
            autoComplete="off"
            spellCheck={false}
            className={FIELD}
          />
          <button
            type="button"
            data-testid="workers-ai-save"
            onClick={() => void save()}
            disabled={saving || (!draft && !saved && !accountChanged)}
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
            data-testid="workers-ai-test"
            onClick={() => void test()}
            disabled={testing || saving || (!draft && !saved)}
            className="flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? t("keys.testing") : t("keys.test")}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
      {verdict && <p role="status" className={cn("mt-1 text-[12px]", verdict.ok ? "text-success" : "text-danger")}>{verdict.text}</p>}
      <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex cursor-pointer items-center gap-1 text-[12px] text-accent hover:underline">
        {t("decider.workersAi.getKey")}
        <ExternalLink size={11} aria-hidden="true" />
      </a>
    </Card>
  );
}
