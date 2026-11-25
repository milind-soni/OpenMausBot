import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";

import type { GithubSignInStatus } from "../../../shared/github-sign-in";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { copyText, COPY_FEEDBACK_MS } from "@/lib/copy-text";
import {
  GITHUB_NEW_TOKEN_URL, githubManageUrl, githubSignIn, groupCode, isGithubDeviceUrl, spellCode,
  type GithubSignInStore, type GithubSignInView,
} from "@/lib/github-sign-in";
import { intlLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const GITHUB_MARK = "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

/** GitHub's mark on the plate an app's tile gets when it has no logo of its own, so it reads on every skin; bare (no
 * `plate`) where a card's small icon goes. */
export function GithubMark({ className = "size-10", plate = true }: { className?: string; plate?: boolean }) {
  const mark = <svg viewBox="0 0 16 16" aria-hidden="true" className={plate ? "size-[55%]" : className} fill="currentColor"><path d={GITHUB_MARK} /></svg>;
  if (!plate) return mark;
  return <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center rounded-[8px] bg-raised text-ink", className)}>{mark}</span>;
}

const SOURCE: Record<"mausbot" | "token" | "cli", LocaleKey> = {
  mausbot: "githubSignIn.source.mausbot",
  cli: "githubSignIn.source.cli",
  token: "githubSignIn.source.token",
};
const LAST: Record<"expired" | "failed" | "cancelled", LocaleKey> = {
  expired: "githubSignIn.last.expired",
  failed: "githubSignIn.last.failed",
  cancelled: "githubSignIn.last.cancelled",
};
const LINK = "inline-flex items-center gap-1 text-[12px] font-medium text-accent-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-sm";
const FIELD = "h-8 w-full min-w-0 rounded-lg bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50";
const NOTE = "text-[12px] leading-4 text-ink-secondary";
export const GITHUB_PRIMARY = "ui-button ui-button-md ui-button-pill ui-button-primary";

/** The line that says where GitHub stands, beside the title. */
export function githubHeadline(view: GithubSignInView): string {
  const status = view.status;
  if (!status) return t("githubSignIn.pitch");
  switch (status.state) {
    case "signed-out": return t("githubSignIn.pitch");
    case "installing": return t("githubSignIn.preparing");
    case "signing-in": return t("githubSignIn.typeCode");
    case "signed-in": return t("githubSignIn.connectedAs", { login: status.login });
    case "invalid": return t("githubSignIn.pitch");
  }
}

/** Everything under the headline for each state: the code to type, who is signed in, a token to paste instead. */
export function GithubSignInDetails({ view, store = githubSignIn }: { view: GithubSignInView; store?: GithubSignInStore }) {
  const status = view.status;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {status?.state === "invalid" && <p data-github-invalid className="text-[13px] leading-[18px] text-warning">{t("githubSignIn.invalid")}</p>}
      {status?.state === "signed-out" && status.download && !view.refused && <p className={NOTE}>{t("githubSignIn.download")}</p>}
      {status && status.last && (status.state === "signed-out" || status.state === "invalid") && !view.refused && (
        <p data-github-last={status.last.outcome} className="text-[12px] leading-4 text-ink-tertiary">{t(LAST[status.last.outcome])}</p>
      )}
      {status?.state === "signing-in" && <DeviceCode status={status} />}
      {status?.state === "signed-in" && <SignedIn status={status} />}
      {view.refused && status?.state !== "signed-in" && status?.state !== "signing-in" && <TokenForm view={view} store={store} />}
      {view.error && <p role="alert" className="text-[12px] leading-4 text-danger">{t(view.error)}</p>}
    </div>
  );
}

function DeviceCode({ status }: { status: Extract<GithubSignInStatus, { state: "signing-in" }> }) {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (reset.current) clearTimeout(reset.current); }, []);
  const code = groupCode(status.code);
  const url = isGithubDeviceUrl(status.verificationUrl) ? status.verificationUrl : null;
  const copy = () => {
    void copyText(code).then((result) => {
      if (result !== "copied") return;
      setCopied(true);
      if (reset.current) clearTimeout(reset.current);
      reset.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    });
  };
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    copy();
    // The desktop app hands links to the person's browser; a browser or the phone's web view follows the link itself.
    if (window.ogb && url) {
      event.preventDefault();
      void openExternalLink(url);
    }
  };
  const expires = new Intl.DateTimeFormat(intlLocale(), { hour: "numeric", minute: "2-digit" }).format(new Date(status.expiresAt));
  return (
    <div data-github-device-code className="mt-1 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-github-code
          aria-hidden="true"
          className="select-all rounded-lg bg-ink/[0.045] px-3 py-1 font-mono text-[20px] font-semibold leading-7 tracking-[0.12em] text-ink tabular-nums"
        >
          {code}
        </span>
        <span className="sr-only">{t("githubSignIn.codeAria", { code: spellCode(code) })}</span>
        <button type="button" onClick={copy} aria-label={t("githubSignIn.copyCode")} title={t("githubSignIn.copyCode")} className="ui-icon-button rounded-full hover:bg-ink/[0.06]">
          {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        </button>
        <span aria-live="polite" className="sr-only">{copied ? t("githubSignIn.copied") : ""}</span>
      </div>
      {url && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a data-github-open href={url} target="_blank" rel="noopener noreferrer" onClick={open} className={cn(GITHUB_PRIMARY, "gap-1.5")}>
            {t("githubSignIn.copyAndOpen")}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
          <span className={NOTE}>{t("githubSignIn.anyDevice", { address: url.replace(/^https:\/\//, "") })}</span>
        </div>
      )}
      <p role="status" className="flex items-center gap-1.5 text-[12px] leading-4 text-ink-tertiary">
        <Loader2 size={12} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
        {t("githubSignIn.waiting", { time: expires })}
      </p>
    </div>
  );
}

function SignedIn({ status }: { status: Extract<GithubSignInStatus, { state: "signed-in" }> }) {
  const orgs = status.orgs?.filter(Boolean) ?? [];
  return (
    <>
      <p className={NOTE}>
        {t(SOURCE[status.source])}
        {orgs.length > 0 && <> · {t("githubSignIn.orgs", { orgs: new Intl.ListFormat(intlLocale(), { style: "narrow", type: "conjunction" }).format(orgs) })}</>}
      </p>
      {status.source === "cli" && <p data-github-cli-reason className={NOTE}>{t("githubSignIn.cliReason")}</p>}
      <a href={githubManageUrl(status.source)} target="_blank" rel="noopener noreferrer" className={LINK}
        onClick={(event) => { if (window.ogb) { event.preventDefault(); void openExternalLink(githubManageUrl(status.source)); } }}>
        {t("githubSignIn.manage")}
        <ExternalLink size={11} aria-hidden="true" />
      </a>
    </>
  );
}

/** A pasted token: masked, sent once, and the field is emptied as it goes, whatever GitHub answers. */
function TokenForm({ view, store }: { view: GithubSignInView; store: GithubSignInStore }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const busy = view.busy === "token";
  const submit = () => {
    const token = draft.trim();
    setDraft("");
    if (token) void store.saveToken(token);
  };
  return (
    <div data-github-refused className="flex flex-col gap-1.5">
      <p className={NOTE}>{t("githubSignIn.refused")}</p>
      {!open ? (
        <button type="button" aria-expanded={false} onClick={() => setOpen(true)} className={cn(LINK, "self-start")}>{t("githubSignIn.pasteInstead")}</button>
      ) : (
        <form data-github-token-form className="flex flex-col gap-1.5" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="flex items-center gap-2">
            <input
              type="password"
              name="github-token"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              aria-label={t("githubSignIn.tokenLabel")}
              placeholder={t("githubSignIn.tokenPlaceholder")}
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              className={FIELD}
            />
            <button type="submit" disabled={busy || !draft.trim()} className={GITHUB_PRIMARY}>
              {busy ? <Loader2 size={14} aria-label={t("common.checking")} className="animate-spin" /> : t("connectors.action.connect")}
            </button>
          </div>
          <p className="text-[12px] leading-4">
            <a href={GITHUB_NEW_TOKEN_URL} target="_blank" rel="noopener noreferrer"
              className="rounded-sm font-medium text-accent-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              onClick={(event) => { if (window.ogb) { event.preventDefault(); void openExternalLink(GITHUB_NEW_TOKEN_URL); } }}>
              {t("githubSignIn.tokenCreate")}{"\u00a0"}
              <ExternalLink size={11} aria-hidden="true" className="inline-block align-[-1px]" />
            </a>
          </p>
        </form>
      )}
    </div>
  );
}
