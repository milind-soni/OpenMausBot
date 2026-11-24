import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { githubSignIn, useGithubSignIn, type GithubSignInStore } from "@/lib/github-sign-in";
import { t } from "@/lib/i18n";
import { api, type Bot, type Message } from "@/state/store";
import { ASK_SECONDARY_BUTTON, askPrimary, AskCard, AskSettledLine } from "../AskCard";
import { githubHeadline, GithubMark, GithubSignInDetails } from "./GithubSignInDetails";

/** The card a chat shows after a clone, fetch or push failed because GitHub isn't connected: the same sign-in as Apps,
 * right where the work stopped. A client that does not draw it shows the message's text instead. */
export function GithubChatCard({ botId, color, threadId, message, store = githubSignIn }: {
  botId: string;
  color?: Bot["color"];
  threadId: string;
  message: Message;
  store?: GithubSignInStore;
}) {
  const connector = message.connector!;
  const view = useGithubSignIn(store);
  // What another card or Apps read earlier may be out of date: this card asks again before it says connected.
  const [checked, setChecked] = useState(false);
  const signedIn = checked && view.status?.state === "signed-in" ? view.status : null;
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/connector-cards/${encodeURIComponent(message.id)}`;
  const settling = useRef(false);
  useEffect(() => {
    if (connector.status === "connected" || connector.dismissed) return;
    let live = true;
    void store.refresh().finally(() => { if (live) setChecked(true); });
    return () => { live = false; };
  }, [store, connector.status, connector.dismissed]);

  useEffect(() => {
    if (!signedIn || connector.status === "connected" || connector.dismissed || settling.current) return;
    settling.current = true;
    void api(`${endpoint}/status?threadId=${encodeURIComponent(threadId)}`).catch(() => {}).finally(() => { settling.current = false; });
  }, [signedIn, connector.status, connector.dismissed, endpoint, threadId]);

  if (connector.dismissed || connector.superseded || view.phase === "hidden") return null;

  if (signedIn || connector.status === "connected") {
    return (
      <AskSettledLine ariaLabel={connector.label}>
        <span className="text-ink-secondary">{connector.label}</span>
        <span> · {signedIn ? t("githubSignIn.connectedAs", { login: signedIn.login }) : t("connectors.card.connected")}</span>
      </AskSettledLine>
    );
  }

  const state = checked ? view.status?.state : undefined;
  const dismiss = () => void api(`${endpoint}/dismiss`, { method: "POST", body: JSON.stringify({ threadId }) }).catch(() => {});
  const spinner = <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />;
  return (
    <AskCard
      ariaLabel={connector.label}
      icon={<GithubMark className="size-4 rounded-[4px]" />}
      title={message.text}
      explanation={checked && view.phase === "ready" ? githubHeadline(view) : undefined}
      onDismiss={dismiss}
      dismissLabel={t("connectors.card.notNow")}
      footer={
        view.phase === "error" ? (
          <button type="button" onClick={() => void store.refresh()} className={ASK_SECONDARY_BUTTON}>{t("connectors.action.retry")}</button>
        ) : state === "installing" || state === "signing-in" ? (
          <button type="button" data-github-cancel disabled={view.busy !== null} onClick={() => void store.cancel()} className={ASK_SECONDARY_BUTTON}>
            {view.busy === "cancel" ? spinner : t("common.cancel")}
          </button>
        ) : state === "signed-out" || state === "invalid" ? (
          <button type="button" data-github-connect disabled={view.busy !== null} onClick={() => void store.start()} {...askPrimary(color)}>
            {view.busy === "start" ? spinner : t(state === "invalid" ? "githubSignIn.connectAgain" : "githubSignIn.connectGithub")}
          </button>
        ) : !checked || view.phase === "loading" ? spinner : null
      }
    >
      {checked && view.phase === "ready" && <GithubSignInDetails view={view} store={store} />}
    </AskCard>
  );
}
