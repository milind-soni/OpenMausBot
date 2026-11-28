import { useEffect } from "react";
import { Check, Loader2 } from "lucide-react";

import { githubSignIn, useGithubSignIn, type GithubSignInStore, type GithubSignInView } from "@/lib/github-sign-in";
import { t } from "@/lib/i18n";
import { githubHeadline, GithubMark, GithubSignInDetails } from "./GithubSignInDetails";

/** What the Apps search box matches for the GitHub sign-in row. */
export const GITHUB_CARD_SEARCH = "github git pull requests repositories push clone";
/** The catalog category the row also shows under. */
export const GITHUB_CARD_CATEGORIES = ["Developer tools"];

const PILL = "inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink transition-colors hover:bg-raised-hover disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** The action at the row's end for each state; none for the person's own GitHub CLI, which is never signed out here. */
export function GithubRowAction({ view, store, className = PILL }: { view: GithubSignInView; store: GithubSignInStore; className?: string }) {
  const spinner = <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />;
  if (view.phase === "loading") return <button type="button" disabled className={className} aria-label={t("common.checking")}>{spinner}</button>;
  if (view.phase === "error") return <button type="button" onClick={() => void store.refresh()} className={className}>{t("connectors.action.retry")}</button>;
  const state = view.status?.state;
  // Start was refused: starting again gets the same answer, so the token's Connect is the one action.
  if ((state === "signed-out" || state === "invalid") && view.refused) return null;
  if (state === "signed-out" || state === "invalid") {
    return (
      <button type="button" data-github-connect disabled={view.busy !== null} onClick={() => void store.start()} className={className}>
        {view.busy === "start" ? spinner : t(state === "invalid" ? "githubSignIn.connectAgain" : "connectors.action.connect")}
      </button>
    );
  }
  if (state === "installing" || state === "signing-in") {
    return (
      <button type="button" data-github-cancel disabled={view.busy !== null} onClick={() => void store.cancel()} className={className}>
        {view.busy === "cancel" ? spinner : t("common.cancel")}
      </button>
    );
  }
  if (state === "signed-in" && view.status?.state === "signed-in" && view.status.source !== "cli") {
    return (
      <button type="button" data-github-disconnect disabled={view.busy !== null} onClick={() => void store.signOut()} className={className}>
        {view.busy === "sign-out" ? spinner : t("connectors.disconnect")}
      </button>
    );
  }
  return null;
}

/** GitHub in Apps: the server's own sign-in, which bots' git and pull requests use. Nothing shows for a person who may
 * not manage it. */
export function GithubAppCard({ store = githubSignIn, refreshKey = 0 }: { store?: GithubSignInStore; refreshKey?: number }) {
  const view = useGithubSignIn(store);
  useEffect(() => { if (refreshKey > 0) void store.refresh(true); }, [store, refreshKey]);
  if (view.phase === "hidden") return null;
  const state = view.status?.state ?? "loading";
  const signedIn = state === "signed-in";
  const headline = githubHeadline(view);
  return (
    <div data-app-tile="github-sign-in" data-github-state={view.phase === "ready" ? state : view.phase}
      className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40">
      <div className="flex items-center gap-3">
        <GithubMark />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">{t("githubSignIn.title")}</span>
            {signedIn && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />}
            {state === "installing" && <Loader2 size={13} aria-hidden="true" className="shrink-0 animate-spin text-ink-tertiary motion-reduce:animate-none" />}
          </div>
          <p dir="auto" className="truncate text-[13px] leading-[18px] text-ink-secondary" title={headline}>{headline}</p>
        </div>
        <GithubRowAction view={view} store={store} />
      </div>
      <div className="ps-[52px] pt-1 empty:hidden [&>div:empty]:hidden">
        <GithubSignInDetails view={view} store={store} />
      </div>
    </div>
  );
}
