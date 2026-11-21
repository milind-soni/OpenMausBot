import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { loginSite } from "../../../shared/logins";
import { t } from "@/lib/i18n";
import { Select } from "../Select";
import type { LocaleKey } from "@/locales";

export { cookieImportAvailable, siteOfAddress } from "./cookie-import";

const button = "rounded-md p-1.5 text-ink-secondary hover:bg-inset hover:text-ink";
const field = "w-full rounded-lg bg-inset px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-accent disabled:opacity-60";

const REASONS: Record<string, LocaleKey> = {
  "not-a-site": "browser.cookieImport.reason.notASite",
  google: "browser.cookieImport.reason.google",
  "no-source": "browser.cookieImport.reason.noSource",
  "key-denied": "browser.cookieImport.reason.keyDenied",
  "full-disk-access": "browser.cookieImport.reason.fullDiskAccess",
  "app-bound": "browser.cookieImport.reason.appBound",
  locked: "browser.cookieImport.reason.locked",
  unreadable: "browser.cookieImport.reason.unreadable",
  "nothing-found": "browser.cookieImport.reason.nothingFound",
  "no-destination": "browser.cookieImport.reason.noDestination",
};

/** The site an import takes, as the server reads it: the registrable domain of what was typed. */
export function importedSite(typed: string): string {
  const text = typed.trim().toLowerCase();
  if (!text) return "";
  let host = text;
  if (/^[a-z][a-z0-9+.-]*:\/\//u.test(text)) {
    try { host = new URL(text).hostname; } catch { return text; }
  }
  return loginSite(host);
}

/**
 * A site's sign-in from one of the person's own browsers into a bot's: they pick the browser, its profile and the
 * site, and confirm a sentence naming all three and the bot. Security: only counts and a reason come back.
 */
export function CookieImportDialog({ open, botId, botName, threadId, site: initialSite, onClose, onImported }: {
  open: boolean;
  botId: string;
  botName: string;
  threadId: string | null;
  site: string;
  onClose: () => void;
  /** The import went through: the site it took and the browser it came from. */
  onImported?: (imported: { site: string; browser: string }) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opening = useRef(initialSite);
  opening.current = initialSite;
  const [sources, setSources] = useState<BrowserCookieSource[] | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [site, setSite] = useState(initialSite);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (open) dialog.current?.showModal(); else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setSources(null);
    setResult(null);
    // The site the page showed when the person opened this, not wherever the bot browses on to meanwhile.
    setSite(opening.current);
    void (window.ogb?.browserCookies?.sources() ?? Promise.resolve([])).then((found) => {
      if (!live) return;
      setSources(found);
      setSourceId(found[0]?.id ?? "");
      setProfileId(found[0]?.profiles[0]?.id ?? "");
    }, () => { if (live) setSources([]); });
    return () => { live = false; };
  }, [open]);

  const source = sources?.find((candidate) => candidate.id === sourceId);
  const profile = source?.profiles.find((candidate) => candidate.id === profileId);
  const shownSite = importedSite(site);
  const ready = Boolean(source && profile && shownSite) && !busy;

  const start = async () => {
    const bridge = window.ogb?.browserCookies;
    if (!bridge || !source || !profile) return;
    setBusy(true);
    setResult(null);
    try {
      const done = await bridge.import({ botId, threadId, site: site.trim(), source: source.id, profile: profile.id });
      const unread = done.ok ? (done.skipped.protected ?? 0) + (done.skipped.failed ?? 0) : 0;
      if (done.ok && done.imported > 0) onImported?.({ site: done.site, browser: source.name });
      setResult(done.ok
        ? { tone: "ok", text: t(done.imported === 1 ? "browser.cookieImport.doneOne" : "browser.cookieImport.done", { count: done.imported, site: done.site })
          + (unread ? ` ${t("browser.cookieImport.partial", { count: unread, browser: source.name })}` : "") }
        : { tone: "error", text: t(REASONS[done.reason] ?? "browser.cookieImport.reason.unreadable", { browser: source.name }) });
    } catch {
      setResult({ tone: "error", text: t("browser.cookieImport.reason.unreadable", { browser: source.name }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="cookie-import-title" data-native-view-overlay="" className="m-auto w-[min(420px,calc(100%-32px))] rounded-2xl border border-hairline/50 bg-card p-5 text-ink shadow-2xl backdrop:bg-black/40">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="cookie-import-title" className="text-[14px] font-medium">{t("browser.cookieImport.title")}</h2>
        <button type="button" className={button} aria-label={t("common.close")} onClick={onClose}><X size={16} /></button>
      </div>
      {sources === null ? (
        <p className="text-[13px] text-ink-secondary">{t("browser.cookieImport.looking")}</p>
      ) : sources.length === 0 ? (
        <p className="text-[13px] text-ink-secondary">{t("browser.cookieImport.none")}</p>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (ready) void start(); }}>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">{t("browser.cookieImport.from")}
              <Select className="w-full" value={sourceId} disabled={busy} onChange={(event) => {
                const next = sources.find((candidate) => candidate.id === event.target.value);
                setSourceId(event.target.value);
                setProfileId(next?.profiles[0]?.id ?? "");
              }}>
                {sources.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">{t("browser.cookieImport.profile")}
              <Select className="w-full" value={profileId} disabled={busy} onChange={(event) => setProfileId(event.target.value)}>
                {source?.profiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </Select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">{t("browser.cookieImport.site")}
            <input className={field} value={site} disabled={busy} spellCheck={false} autoComplete="off" maxLength={253} placeholder="example.com" onChange={(event) => setSite(event.target.value)} />
          </label>
          {source && profile && shownSite ? (
            <p className="text-[12px] text-ink-secondary">{t("browser.cookieImport.confirm", { site: shownSite, browser: source.name, profile: profile.name, name: botName })}</p>
          ) : null}
          <p className="text-[12px] text-ink-tertiary">{t("browser.cookieImport.note")}</p>
          {result ? <p role={result.tone === "error" ? "alert" : "status"} className={result.tone === "error" ? "text-[12px] text-danger" : "text-[12px] text-ink"}>{result.text}</p> : null}
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-lg px-4 py-2 text-[12px] text-ink-secondary hover:bg-inset" onClick={onClose}>{t(result?.tone === "ok" ? "common.close" : "common.cancel")}</button>
            <button type="submit" disabled={!ready} className="rounded-lg bg-accent px-4 py-2 text-[12px] text-accent-ink disabled:opacity-40">{busy ? t("browser.cookieImport.importing") : t("browser.cookieImport.import")}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
