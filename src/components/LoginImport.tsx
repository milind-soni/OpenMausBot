import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { LOGIN_IMPORT_MAX_BYTES, parseLoginCsv, type ImportedLogin } from "../../shared/login-import";
import { loginMatchesHost, normalizeLoginHost, type LoginBots, type LoginSummary } from "../../shared/logins";
import { importLogins } from "@/lib/logins";
import { t } from "@/lib/i18n";
import { LoginBotPicker } from "./LoginForm";

export function LoginImport({ logins, bots, onImported }: {
  logins: LoginSummary[];
  bots: ReadonlyArray<{ id: string; name: string }>;
  onImported: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ImportedLogin[] | null>(null);
  const [invalid, setInvalid] = useState(0);
  const [duplicates, setDuplicates] = useState(0);
  const [allowed, setAllowed] = useState<LoginBots>("all");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const cancel = () => {
    generation.current++; setEntries(null); setOpen(false); setError(""); setAllowed("all");
  };
  const read = async (file: File) => {
    const current = ++generation.current;
    setEntries(null); setError(""); setMessage("");
    if (file.size > LOGIN_IMPORT_MAX_BYTES) { setError(t("settings.logins.import.size")); return; }
    try {
      const parsed = parseLoginCsv(await file.text());
      if (generation.current !== current) return;
      if (!parsed.ok) { setError(t(`settings.logins.import.${parsed.error}`)); return; }
      const fresh = parsed.entries.filter((entry) => !logins.some((login) =>
        login.username.toLowerCase() === entry.username.toLowerCase() && loginMatchesHost(login, normalizeLoginHost(entry.site)!)));
      setEntries(fresh); setInvalid(parsed.invalidRows.length);
      setDuplicates(parsed.duplicates + parsed.entries.length - fresh.length);
    } catch { if (generation.current === current) setError(t("settings.logins.import.readError")); }
  };
  const save = async () => {
    if (busy || !entries?.length) return;
    setBusy(true); setError("");
    let result: { imported: number; skipped: number };
    try { result = await importLogins(entries, allowed); }
    catch { setError(t("settings.logins.import.saveError")); setBusy(false); return; }
    setEntries(null); setOpen(false); setAllowed("all");
    setMessage(t("settings.logins.import.saved", { count: String(result.imported), skipped: String(result.skipped) }));
    try { await onImported(); } finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-2" data-login-import>
    {!open ? <button type="button" className="ui-button ui-button-md self-start" disabled={busy}
      onClick={() => { setOpen(true); setMessage(""); }}><Upload size={14} />{t("settings.logins.import.open")}</button> :
      <div className="flex flex-col gap-3 rounded-lg bg-inset/60 p-3" aria-busy={busy}>
        <p className="text-[13px] text-ink-secondary">{t("settings.logins.import.help")}</p>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-ink-secondary">
          {t("settings.logins.import.file")}
          <input type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0]; event.target.value = ""; if (file) void read(file);
          }} />
        </label>
        {entries !== null && <>
          <p role="status" className="text-[13px] text-ink">{t("settings.logins.import.preview", {
            count: String(entries.length), invalid: String(invalid), duplicates: String(duplicates),
          })}</p>
          {!!entries.length && <>
            <ul className="max-h-48 overflow-y-auto divide-y divide-hairline/30 text-[12px]" aria-label={t("settings.logins.import.previewLabel")}>
              {entries.map((entry, index) => <li key={index} className="flex flex-wrap gap-x-3 py-1.5">
                <span dir="ltr" className="break-all">{normalizeLoginHost(entry.site)}</span>
                <span dir="auto" className="break-all text-ink-secondary">{entry.username || t("settings.logins.noUsername")}</span>
              </li>)}
            </ul>
            <p className="text-[12px] text-ink-secondary">{t("settings.logins.import.exact")}</p>
            <LoginBotPicker value={allowed} onChange={setAllowed} bots={bots} disabled={busy} />
          </>}
        </>}
        <p className="text-[12px] text-ink-tertiary">{t("settings.logins.import.private")}</p>
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="ui-button ui-button-md" disabled={busy} onClick={cancel}>{t("logins.cancel")}</button>
          <button type="button" className="ui-button ui-button-md ui-button-primary" disabled={busy || !entries?.length}
            onClick={() => void save()}>{t("settings.logins.import.confirm", { count: String(entries?.length ?? 0) })}</button>
        </div>
      </div>}
    {message && <p role="status" className="text-[13px] text-ink">{message}</p>}
  </div>;
}
