import type { ClipboardEvent } from "react";
import { Plus, X } from "lucide-react";

import { t } from "@/lib/i18n";
import type { PastedGap } from "@/lib/mcp-paste";

import { secretRow, type SecretRow } from "./mcp-draft";

export function gapHint(gap: PastedGap): string {
  return t(gap.kind === "variable" ? "mcp.paste.variable" : "mcp.paste.placeholder", { name: gap.names.join(", ") });
}

const INPUT = "w-full min-w-0 rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 font-mono text-[12px] text-ink outline-none focus:border-accent";

/** Name and value rows. Values are typed like passwords and never shown back. `valuesOf` shows only values, under their
 * names: the ones a paste couldn't give, or every named one. */
export function McpSecretRows({ kind, rows, onChange, valuesOf, placeholder }: {
  kind: "header" | "env";
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
  valuesOf?: "gaps" | "named";
  placeholder?: string;
}) {
  const update = (id: number, patch: Partial<SecretRow>) => onChange(rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  const separator = kind === "header" ? ":" : "=";
  const pasteName = (row: SecretRow, event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    const at = text.indexOf(separator);
    if (at <= 0) return;
    event.preventDefault();
    update(row.id, { name: text.slice(0, at).trim(), value: text.slice(at + 1).trim() });
  };
  const valueInput = (row: SecretRow) => (
    <input type="password" aria-label={row.name.trim() || t("mcp.row.value")} value={row.value} autoComplete="new-password" spellCheck={false}
      placeholder={placeholder ?? (row.saved ? t("mcp.oauth.secretSaved") : t("mcp.row.value"))}
      onChange={(event) => update(row.id, { value: event.target.value })} className={INPUT} />
  );
  return (
    <div className="space-y-2">
      {rows.filter((row) => valuesOf === "gaps" ? row.gap : valuesOf === "named" ? row.name.trim() : true).map((row) => (
        <div key={row.id}>
          {valuesOf ? (
            <label className="block">
              <span className="mb-1.5 block font-mono text-[12px] font-medium text-ink-secondary">{row.name}</span>
              {valueInput(row)}
            </label>
          ) : (
            <div className="flex items-center gap-2">
              <input aria-label={t(kind === "header" ? "mcp.row.headerName" : "mcp.row.envName")} value={row.name} spellCheck={false} autoComplete="off"
                placeholder={kind === "header" ? "Authorization" : "API_KEY"} onChange={(event) => update(row.id, { name: event.target.value })}
                onPaste={(event) => pasteName(row, event)}
                className={`${INPUT} max-w-[42%]`} />
              {valueInput(row)}
              <button type="button" aria-label={t("mcp.row.remove", { name: row.name.trim() || t("mcp.row.value") })}
                onClick={() => onChange(rows.length > 1 ? rows.filter((other) => other.id !== row.id) : [secretRow()])}
                className="shrink-0 rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink">
                <X size={14} />
              </button>
            </div>
          )}
          {row.gap && !row.value.trim() && <p className="mt-1 text-[11px] leading-relaxed text-warning">{gapHint(row.gap)}</p>}
        </div>
      ))}
      {!valuesOf && (
        <button type="button" onClick={() => onChange([...rows, secretRow()])} className="inline-flex items-center gap-1 rounded-lg px-1 py-1 text-[12px] font-medium text-accent hover:underline">
          <Plus size={13} /> {t("mcp.row.add")}
        </button>
      )}
    </div>
  );
}
