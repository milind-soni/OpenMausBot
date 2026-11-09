import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, RotateCw } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { keySaved } from "@/lib/product-events";
import { addedServers } from "@/lib/openai-compat-endpoints";
import { cn } from "@/lib/cn";
import type { OllamaStatus } from "../../shared/local-model";
import { KEY_FIELD } from "./keys/KeyRow";
import { OllamaStatusLine } from "./OllamaStatusLine";

/** Ollama ignores the key; the server's add-server route still asks for one. */
const PLACEHOLDER_KEY = "ollama";
const DOWNLOAD_URL = "https://ollama.com/download";

export const ollamaBaseUrl = (origin: string) => `${origin.replace(/\/+$/, "")}/v1`;
const sameBase = (a: string | undefined, b: string) => a?.trim().replace(/\/+$/, "") === b;

/** Finds Ollama on this computer, or at an address someone enters, and adds it in one click: no key, no URL to type. */
export function OllamaServer({ visible }: { visible: boolean }) {
  const { state, dispatch, refreshInstances } = useStore();
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latest = useRef(0);
  const looked = useRef(false);

  const check = useCallback((url: string) => {
    const request = ++latest.current;
    setChecking(true);
    setError(null);
    void api<{ status: OllamaStatus }>(`/api/instances/ollama${url ? `?url=${encodeURIComponent(url)}` : ""}`)
      .then((result) => { if (request === latest.current) setStatus(result.status); })
      .catch((cause: Error) => { if (request === latest.current) { setStatus(null); setError(cause.message || t("apiInstances.failed")); } })
      .finally(() => { if (request === latest.current) setChecking(false); });
  }, []);
  // Connections mounts every row, folded or not; a folded section has nothing to show yet.
  useEffect(() => {
    if (!visible || looked.current) return;
    looked.current = true;
    check("");
  }, [visible, check]);

  const target = status ? ollamaBaseUrl(status.url) : null;
  const present = Boolean(target && (addedServers(state.instances).some((server) => server.url === target) || sameBase(state.config?.openaiCompat?.url, target)));
  const canAdd = Boolean(target && !present && !busy && !checking && (status?.state === "ready" || status?.state === "no-models"));

  const add = () => {
    if (!canAdd || !target) return;
    setBusy(true);
    setError(null);
    void api<{ instances?: unknown }>("/api/instances/openai-compat", {
      method: "POST",
      body: JSON.stringify({ displayName: "Ollama", url: target, key: PLACEHOLDER_KEY, catalog: "ollama" }),
    }).then(
      async (created) => {
        keySaved("custom_endpoint", "settings", "unverified");
        if (Array.isArray(created.instances)) dispatch({ type: "instances", instances: created.instances as InstanceInfo[] });
        else await refreshInstances({ reportErrors: true });
      },
      (cause: unknown) => {
        keySaved("custom_endpoint", "settings", "error");
        setError(cause instanceof Error && cause.message ? cause.message : t("apiInstances.failed"));
      },
    ).finally(() => setBusy(false));
  };

  return (
    <div data-ollama-server>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("ollama.desc")}</p>
      <div role="status" aria-live="polite" className="mt-2">
        {checking
          ? <p className="flex items-center gap-1.5 text-[12px] leading-4 text-ink-secondary"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{t("ollama.checking")}</p>
          : status && <OllamaStatusLine status={status} />}
      </div>
      {!checking && status?.state === "not-running" && (
        <a href={DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[12px] font-medium text-accent-text hover:underline">{t("ollama.download")}</a>
      )}
      <div className="mt-2 flex flex-col gap-1.5">
        <input
          type="url"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") check(address.trim()); }}
          placeholder="http://127.0.0.1:11434"
          aria-label={t("ollama.address")}
          spellCheck={false}
          disabled={busy}
          className={cn(KEY_FIELD, "font-mono")}
        />
        <p className="text-[12px] leading-4 text-ink-secondary">{t("ollama.addressHint")}</p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={add} disabled={!canAdd} className="ui-button">
            {busy ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : <Plus size={12} aria-hidden="true" />}
            {busy ? t("ollama.adding") : t("ollama.add")}
          </button>
          <button type="button" onClick={() => check(address.trim())} disabled={checking || busy} className="ui-button">
            <RotateCw size={12} aria-hidden="true" />
            {t("common.checkAgain")}
          </button>
        </div>
        {present && <p className="text-[12px] text-ink-secondary">{t("ollama.added")}</p>}
      </div>
      {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
