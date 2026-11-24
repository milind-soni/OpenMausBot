import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { api, type InstanceInfo } from "@/state/store";
import { useStoreActions, useStoreSelector } from "@/state/store-select";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { KEY_FIELD } from "./keys/KeyRow";
import { Switch } from "./SettingsPrimitives";
import { Select } from "./Select";

const INPUT = cn(KEY_FIELD, "font-sans");
const ICON_BUTTON = "ui-icon-button shrink-0 hover:text-ink";
const VARS_LABEL = "{threadId}, {botId}, {turnId}, {providerInstanceId}";

interface HeaderDraft {
  name: string;
  value: string;
  keepExisting: boolean;
  required: boolean;
  secret: boolean;
}

function toDrafts(summary: InstanceInfo["customHeaders"] | undefined): HeaderDraft[] {
  return (summary?.headers ?? []).map((entry) => ({
    name: entry.name,
    value: entry.secret ? "" : entry.value ?? "",
    keepExisting: Boolean(entry.secret && entry.configured),
    required: entry.required,
    secret: entry.secret,
  }));
}

export function OpenAiCompatCustomHeaders({ server, disabled = false }: { server: InstanceInfo; disabled?: boolean }) {
  const { dispatch, refreshInstances } = useStoreActions();
  const [enabled, setEnabled] = useState(Boolean(server.customHeaders?.enabled));
  const [rows, setRows] = useState<HeaderDraft[]>(() => toDrafts(server.customHeaders));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncedKey = JSON.stringify(server.customHeaders ?? null);
  useEffect(() => {
    setEnabled(Boolean(server.customHeaders?.enabled));
    setRows(toDrafts(server.customHeaders));
    setError(null);
  }, [server.instanceId, syncedKey]);

  const updateRow = (index: number, patch: Partial<HeaderDraft>) => {
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    setRows((current) => [...current, { name: "", value: "", keepExisting: false, required: true, secret: false }]);
  };

  const removeRow = (index: number) => {
    setRows((current) => current.filter((_row, at) => at !== index));
  };

  const insertVariable = (index: number, variable: string) => {
    if (!variable) return;
    setRows((current) =>
      current.map((row, at) => {
        if (at !== index) return row;
        const base = row.keepExisting ? "" : row.value;
        return { ...row, value: `${base}${variable}`, keepExisting: false };
      }),
    );
  };

  const save = () => {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    const payload = {
      enabled,
      headers: rows.map((row) => ({
        name: row.name.trim(),
        ...(row.keepExisting && !row.value ? { keepExisting: true } : { value: row.value }),
        required: row.required,
        secret: row.secret,
      })),
    };
    void api(`/api/instances/${encodeURIComponent(server.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ customHeaders: payload }),
    })
      .then(async (response: { instances?: unknown }) => {
        if (Array.isArray(response.instances)) {
          dispatch({ type: "instances", instances: response.instances as InstanceInfo[] });
        } else {
          await refreshInstances({ reportErrors: true });
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error && cause.message ? cause.message : t("apiInstances.failed"));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-control p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium leading-4 text-ink">{t("apiInstances.customHeadersTitle")}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] leading-4 text-ink-secondary">{t("apiInstances.customHeadersEnable")}</span>
          <Switch
            checked={enabled}
            aria-label={t("apiInstances.customHeadersEnableFor", { name: server.displayName })}
            disabled={busy || disabled}
            onClick={() => setEnabled((on) => !on)}
          />
        </div>
      </div>
      <p className="text-[12px] leading-4 text-ink-secondary">
        {t("apiInstances.customHeadersHint", { vars: VARS_LABEL })}
      </p>
      {rows.map((row, index) => (
        <div key={index} className="flex flex-col gap-1 rounded-lg border border-control p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={row.name}
              onChange={(event) => updateRow(index, { name: event.target.value })}
              placeholder="X-Maus-Thread-ID"
              aria-label={t("apiInstances.customHeaderNameAria", { index: index + 1 })}
              spellCheck={false}
              disabled={busy || disabled}
              className={cn(INPUT, "min-w-0 flex-1")}
            />
            <input
              type={row.secret ? "password" : "text"}
              value={row.value}
              onChange={(event) => updateRow(index, { value: event.target.value, keepExisting: false })}
              placeholder={row.keepExisting ? t("apiInstances.customHeadersKeepSecret") : "{threadId}"}
              aria-label={t("apiInstances.customHeaderValueAria", { index: index + 1 })}
              autoComplete="off"
              spellCheck={false}
              disabled={busy || disabled}
              className={cn(INPUT, "min-w-0 flex-1")}
            />
            <button
              type="button"
              onClick={() => removeRow(index)}
              disabled={busy || disabled}
              aria-label={t("apiInstances.customHeadersRemove", { index: index + 1 })}
              className={`${ICON_BUTTON} hover:bg-danger/10 hover:text-danger`}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <Select
              size="sm"
              value=""
              aria-label={t("apiInstances.customHeaderVariableAria", { index: index + 1 })}
              disabled={busy || disabled}
              onChange={(event) => insertVariable(index, event.target.value)}
            >
              <option value="">{t("apiInstances.customHeaderVarPlaceholder")}</option>
              <option value="{threadId}">{t("apiInstances.customHeadersVarThreadId")}</option>
              <option value="{botId}">{t("apiInstances.customHeadersVarBotId")}</option>
              <option value="{turnId}">{t("apiInstances.customHeadersVarTurnId")}</option>
              <option value="{providerInstanceId}">{t("apiInstances.customHeadersVarProviderId")}</option>
            </Select>
            <div className="flex items-center gap-2 text-[12px] leading-4 text-ink-secondary">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={row.required}
                  disabled={busy || disabled}
                  onChange={(event) => updateRow(index, { required: event.target.checked })}
                />
                {t("apiInstances.customHeadersRequired")}
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={row.secret}
                  disabled={busy || disabled}
                  onChange={(event) => {
                    const nextSecret = event.target.checked;
                    updateRow(index, {
                      secret: nextSecret,
                      ...(!nextSecret && row.keepExisting ? { keepExisting: false } : {}),
                    });
                  }}
                />
                {t("apiInstances.customHeadersSecret")}
              </label>
            </div>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <button type="button" onClick={addRow} disabled={busy || disabled} className="ui-button inline-flex items-center gap-1">
          <Plus size={12} aria-hidden="true" />
          {t("apiInstances.customHeadersAdd")}
        </button>
        <button type="button" onClick={save} disabled={busy || disabled} className="ui-button">
          {busy ? t("apiInstances.customHeadersSaving") : t("apiInstances.customHeadersSave")}
        </button>
      </div>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

/** Custom headers for the built-in OpenAI-compatible server when its base URL is configured. */
export function BuiltInCustomHeaders() {
  const server = useStoreSelector((s) =>
    s.instances.find((instance) => instance.instanceId === "openaiCompat" && instance.driverKind === "openai-compat"),
  );
  const compatUrl = useStoreSelector((s) => s.config?.openaiCompat?.url);
  if (!server || (!compatUrl && !server.customHeaders)) return null;
  return <OpenAiCompatCustomHeaders server={server} />;
}
