import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";

interface SignedInSite { site: string; cookies: number; storage: number }
interface SignedInSitesAnswer { running: boolean; sites: SignedInSite[] }

/** Security: the server reads and clears the browser itself, running or not, and keeps the key. */
export function SignedInSites({ target, scope = {}, sharedBy, disabled = false, bare = false }: {
  target: { profile: string } | { bot: string };
  /** Which conversation's browser is meant, on a Team Cloud. */
  scope?: Readonly<Record<string, string>>;
  sharedBy: string[];
  disabled?: boolean;
  bare?: boolean;
}) {
  const [sites, setSites] = useState<SignedInSite[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (request: () => Promise<SignedInSitesAnswer>) => {
    setBusy(true);
    setError("");
    try { setSites((await request()).sites); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.sites.error")); }
    finally { setBusy(false); }
  };
  const load = () => run(() => api(`/api/browser-sites?${new URLSearchParams({ ...target, ...scope }).toString()}`));
  const signOut = (site?: string) => run(() => api("/api/browser-sites/sign-out", {
    method: "POST",
    body: JSON.stringify({ ...target, ...scope, ...(site ? { site } : {}) }),
  }));

  const key = `${"bot" in target ? `bot:${target.bot}` : `profile:${target.profile}`}${scope.threadId ? `:${scope.threadId}` : ""}`;
  useEffect(() => {
    if (bare) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bare, key]);

  const locked = disabled || busy;
  const buttonClass = "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";
  const list = (
      <div className={bare ? "flex min-w-0 flex-col gap-2" : "mt-2 flex flex-col gap-2"} aria-busy={busy}>
        {sharedBy.length > 1 && <p className="text-[11px] leading-relaxed text-ink-secondary">{t("settings.sites.shared", { names: sharedBy.join(", ") })}</p>}
        {sites === null && !error && <p className="text-[12px] text-ink-secondary">{t("settings.sites.loading")}</p>}
        {sites?.length === 0 && <p className="text-[12px] text-ink-secondary">{t("settings.sites.none")}</p>}
        {!!sites?.length && (
          <ul className="divide-y divide-hairline/30">
            {sites.map((entry) => (
              <li key={entry.site} className="flex min-w-0 items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={entry.site}>{entry.site}</span>
                <button type="button" disabled={locked} onClick={() => void signOut(entry.site)} aria-label={t("settings.sites.signOutOf", { site: entry.site })} className={buttonClass}>
                  <LogOut size={13} />{t("settings.sites.signOut")}
                </button>
              </li>
            ))}
          </ul>
        )}
        {!!sites?.length && (
          <button type="button" disabled={locked} onClick={() => void signOut()} className={`${buttonClass} self-start`}>
            <LogOut size={13} />{t("settings.sites.signOutAll")}
          </button>
        )}
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      </div>
  );
  if (bare) return list;
  return (
    <details className="min-w-0" onToggle={(event) => { if (event.currentTarget.open && !busy) void load(); }}>
      <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary hover:text-ink">{t("settings.sites.title")}</summary>
      {list}
    </details>
  );
}
