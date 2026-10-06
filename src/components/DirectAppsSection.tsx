import { useState } from "react";
import { LogIn } from "lucide-react";

import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import {
  DIRECT_APPS,
  directAppCardState,
  directAppRedirectUri,
  type DirectApp,
  type DirectAppServer,
} from "../../shared/direct-apps.ts";

const DETAIL: Record<DirectApp["id"], LocaleKey> = {
  outlook: "directApps.outlook.detail",
  gmail: "directApps.gmail.detail",
  slack: "directApps.slack.detail",
};

/** Outlook, Gmail, and Slack, each with its own provider sign-in. This
 * section collects the OAuth app the person registered. Tokens stay on
 * this computer. */
export function DirectAppsSection({
  servers,
  restricted,
  busy,
  signingIn,
  onAuthorize,
  onSignIn,
  onSignOut,
}: {
  servers: readonly DirectAppServer[];
  restricted: boolean;
  busy: boolean;
  signingIn: string | null;
  onAuthorize: (app: DirectApp, input: { clientId: string; clientSecret: string; tenant?: string }) => Promise<void>;
  onSignIn: (name: string) => void;
  onSignOut?: (app: DirectApp) => void;
}) {
  const [creds, setCreds] = useState<Record<string, { clientId: string; clientSecret: string; tenant: string }>>({});
  const field = (id: string) => creds[id] ?? { clientId: "", clientSecret: "", tenant: "" };
  const setField = (id: string, key: "clientId" | "clientSecret" | "tenant", value: string) => {
    setCreds((current) => {
      const previous = current[id] ?? { clientId: "", clientSecret: "", tenant: "" };
      return { ...current, [id]: { ...previous, [key]: value } };
    });
  };

  return (
    <section className="mt-4 rounded-2xl border border-hairline/60 bg-card p-4 sm:p-5" aria-labelledby="direct-apps-title">
      <h4 id="direct-apps-title" className="text-[14px] font-medium text-ink">{t("directApps.title")}</h4>
      <p className="mt-1 max-w-[68ch] text-[12px] leading-relaxed text-ink-secondary">{t("directApps.body")}</p>
      <div className="mt-4 grid gap-3">
        {DIRECT_APPS.map((app) => {
          const card = directAppCardState(app, servers);
          const values = field(app.id);
          const pending = busy || signingIn === app.name;
          return (
            <div key={app.id} className="rounded-xl border border-hairline/50 bg-raised/40 p-3.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-[13px] font-medium text-ink">{app.title}</div>
                <button
                  type="button"
                  onClick={() => void openExternalLink(app.docsUrl)}
                  className="text-[11px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
                >
                  {t("directApps.docs")}
                </button>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t(DETAIL[app.id])}</p>
              <p className="mt-2 text-[11px] text-ink-secondary">{t("directApps.redirect")}</p>
              <code className="mt-1 block select-all break-all rounded-lg bg-control/70 px-2 py-1.5 font-mono text-[11px] text-ink">
                {directAppRedirectUri(app)}
              </code>
              {card.kind === "name-taken" && (
                <p role="status" className="mt-2 text-[12px] text-warning">{t("directApps.nameTaken", { name: app.name })}</p>
              )}
              {card.kind === "ready" && card.auth === "signed-in" && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p role="status" className="text-[12px] text-success">
                    {t(card.enabled ? "directApps.signedIn" : "directApps.savedOff", { name: app.title })}
                  </p>
                  {app.transport === "graph" && onSignOut && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onSignOut(app)}
                      className="rounded-lg px-2 py-1 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-40"
                    >
                      {t("directApps.signOut", { name: app.title })}
                    </button>
                  )}
                </div>
              )}
              {card.kind === "ready" && card.auth !== "signed-in" && (
                <button
                  type="button"
                  disabled={restricted || pending}
                  onClick={() => onSignIn(app.name)}
                  className="mt-3 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-accent-ink disabled:opacity-40"
                >
                  <LogIn size={14} /> {t("directApps.signIn", { name: app.title })}
                </button>
              )}
              {card.kind === "create" && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-[12px] font-medium text-ink-secondary">{t("directApps.clientId")}</span>
                    <input
                      value={values.clientId}
                      disabled={restricted}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) => setField(app.id, "clientId", event.target.value)}
                      className="mt-1.5 w-full rounded-lg border border-hairline/60 bg-card px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent disabled:opacity-40"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[12px] font-medium text-ink-secondary">{t("directApps.clientSecret")}</span>
                    <input
                      type="password"
                      value={values.clientSecret}
                      disabled={restricted}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) => setField(app.id, "clientSecret", event.target.value)}
                      className="mt-1.5 w-full rounded-lg border border-hairline/60 bg-card px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent disabled:opacity-40"
                    />
                  </label>
                  {app.transport === "graph" && (
                    <label className="block sm:col-span-2">
                      <span className="text-[12px] font-medium text-ink-secondary">{t("directApps.tenant")}</span>
                      <input
                        value={values.tenant}
                        disabled={restricted}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder="common"
                        onChange={(event) => setField(app.id, "tenant", event.target.value)}
                        className="mt-1.5 w-full rounded-lg border border-hairline/60 bg-card px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent disabled:opacity-40"
                      />
                    </label>
                  )}
                  <div className="sm:col-span-2">
                    <button
                      type="button"
                      disabled={restricted || pending}
                      onClick={() => void onAuthorize(app, values)}
                      className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-accent-ink disabled:opacity-40"
                    >
                      <LogIn size={14} /> {t("directApps.authorize", { name: app.title })}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
