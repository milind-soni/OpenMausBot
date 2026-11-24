import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { githubSignIn, useGithubSignIn, type GithubSignInStore } from "@/lib/github-sign-in";
import { t } from "@/lib/i18n";
import { api, type Bot, type Message } from "@/state/store";
import { ASK_SECONDARY_BUTTON, askPrimary, AskCard, AskSettledLine } from "../AskCard";
import { githubHeadline, GithubMark, GithubSignInDetails } from "./GithubSignInDetails";

type GithubChatCardProps = { botId: string; color?: Bot["color"]; threadId: string; message: Message; store?: GithubSignInStore };

/** The card a chat shows after a clone, a fetch or a push failed because GitHub isn't connected: the same sign-in as Apps,
 * right where the work stopped. A client that does not draw it shows the message's text instead. A card set aside or
 * already connected asks nothing. */
export function GithubChatCard(props: GithubChatCardProps) {
  const connector = props.message.connector!;
  if (connector.dismissed || connector.superseded) return null;
  if (connector.status === "connected") {
    return (
      <AskSettledLine ariaLabel={connector.label}>
        <span className="text-ink-secondary">{connector.label}</span>
        <span> · {t("connectors.card.connected")}</span>
      </AskSettledLine>
    );
  }
  return <OpenGithubCard {...props} />;
}

const statusOf = (cause: unknown) => (cause as { status?: unknown } | null)?.status;

function OpenGithubCard({ botId, color, threadId, message, store = githubSignIn }: GithubChatCardProps) {
  const connector = message.connector!;
  const view = useGithubSignIn(store);
  // Whether this card is the viewer's own: the card's route says (403: someone else's), so nobody is shown their own
  // sign-in on another person's card. Null until it has answered.
  const [mine, setMine] = useState<boolean | null>(null);
  // What another card or Apps read earlier may be out of date: this card has its own answer before it says connected.
  const [checked, setChecked] = useState(false);
  const askedToSettle = useRef(true);
  const cardStatus = `/api/bots/${encodeURIComponent(botId)}/connector-cards/${encodeURIComponent(message.id)}/status?threadId=${encodeURIComponent(threadId)}`;
  const dismissPath = `/api/bots/${encodeURIComponent(botId)}/connector-cards/${encodeURIComponent(message.id)}/dismiss`;

  useEffect(() => {
    let live = true;
    void api(cardStatus).then(() => { if (live) setMine(true); }, (cause) => { if (live) setMine(statusOf(cause) !== 403); });
    void store.fresh().finally(() => { if (live) setChecked(true); });
    return () => { live = false; };
  }, [store, cardStatus]);

  const state = checked ? view.status?.state : undefined;
  // A sign-in finished while the card was shown: the card's route settles it, and a turn parked on it carries on.
  useEffect(() => {
    if (!checked) return;
    if (state !== "signed-in") askedToSettle.current = false;
    else if (!askedToSettle.current && mine) {
      askedToSettle.current = true;
      void api(cardStatus).catch(() => {});
    }
  }, [checked, state, mine, cardStatus]);

  if (mine !== true || view.phase === "hidden") return null;
  if (state === "signed-in" && view.status?.state === "signed-in") {
    return (
      <AskSettledLine ariaLabel={connector.label}>
        <span className="text-ink-secondary">{connector.label}</span>
        <span> · {t("githubSignIn.connectedAs", { login: view.status.login })}</span>
      </AskSettledLine>
    );
  }

  const dismiss = () => void api(dismissPath, { method: "POST", body: JSON.stringify({ threadId }) }).catch(() => {});
  const spinner = <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />;
  return (
    <AskCard
      ariaLabel={connector.label}
      icon={<GithubMark plate={false} className="size-4" />}
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
        ) : (state === "signed-out" || state === "invalid") && !view.refused ? (
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
