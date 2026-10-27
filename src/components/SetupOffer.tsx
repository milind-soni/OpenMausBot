// Set me up under a new bot's greeting (server/setup-request.ts). The press is answered by the server at once, with
// the bot's own line and no model; the next thing the person types in this conversation is what the bot sets itself
// up for. While it waits, a chip above the message box says so and its x stops it.
import { useRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";

import { currentReactor, useReactor } from "@/lib/cloud-guest";
import { t } from "@/lib/i18n";
import { api, useStore, type Bot, type Message } from "@/state/store";
import { ASK_PRIMARY_BUTTON, returnFocusToComposer } from "./AskCard";

const blank = (bot: Pick<Bot, "soul" | "description">): boolean => !bot.soul?.trim() && !bot.description?.trim();

/** The server takes the offer away once it is pressed or the person writes; the bot's own fields and the transcript
 * cover the moments before that reaches this screen (instructions saved right after creation, a line just sent). The
 * conversation's AI must have the tools a bot sets itself up with. */
export function SetupOffer({ botId, threadId, message, transcript }: { botId: string; threadId: string; message: Message; transcript: Message[] }) {
  const { state, dispatch } = useStore();
  const [pressed, setPressed] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A double click lands before the disabled button is drawn.
  const sending = useRef(false);
  const bot = state.bots.find((candidate) => candidate.id === botId);
  if (answered || message.setupOffer !== true || !bot || !blank(bot)) return null;
  if (transcript.some((line) => line.role === "user")) return null;
  const selection = bot.tasks?.find((task) => task.threadId === threadId)?.modelSelection ?? bot.modelSelection;
  if (state.instances.find((instance) => instance.instanceId === selection?.instanceId)?.capabilities?.agentsMcp !== true) return null;

  const press = () => {
    if (sending.current) return;
    sending.current = true;
    setPressed(true);
    setError(null);
    void api<{ message?: Message }>(`/api/bots/${botId}/setup-request`, { method: "POST", body: JSON.stringify({ threadId }) })
      .then((answer) => {
        // The live update brings the same line; this one stands in if that update is lost.
        if (answer?.message) dispatch({ type: "messageAdded", threadId, message: answer.message });
        setAnswered(true);
        returnFocusToComposer();
      })
      .catch((cause: unknown) => {
        sending.current = false;
        setPressed(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <div data-setup-offer-row className="flex flex-col items-start gap-1">
      <button type="button" data-setup-offer={message.id} onClick={press} disabled={pressed} className={ASK_PRIMARY_BUTTON}>
        {pressed ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
        {t("chat.setupOffer.button")}
      </button>
      {error && <p role="alert" dir="auto" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}

/** Waiting here, for this viewer: where people share the place only the presser sees it. `viewer` is read only then,
 * as the viewer's reactor key ("user" where one person uses the place). */
function waiting(bot: Bot | undefined, threadId: string, viewer: () => string): boolean {
  const request = bot?.tasks?.find((task) => task.threadId === threadId)?.setupRequest;
  return Boolean(request && (!request.by || request.by === viewer()));
}

/** The message box's hint while the bot waits to hear what to set itself up for. Read during the composer's render,
 * so it takes the viewer's key without a hook; the chat view subscribes to it, so it is known by then. */
export function setupRequestPlaceholder(bot: Bot | undefined, threadId: string): string | undefined {
  return bot && waiting(bot, threadId, () => currentReactor()) ? t("composer.setupRequest.placeholder", { name: bot.name }) : undefined;
}

/** "Ava is ready to be set up ×" above the message box, while this conversation waits. */
export function SetupRequestChip({ bot, threadId }: { bot: Bot; threadId: string }) {
  return bot.tasks?.find((task) => task.threadId === threadId)?.setupRequest ? <WaitingChip bot={bot} threadId={threadId} /> : null;
}

function WaitingChip({ bot, threadId }: { bot: Bot; threadId: string }) {
  const [stopping, setStopping] = useState(false);
  const viewer = useReactor();
  if (!waiting(bot, threadId, () => viewer)) return null;
  const stop = () => {
    if (stopping) return;
    setStopping(true);
    void api(`/api/bots/${bot.id}/setup-request`, { method: "DELETE", body: JSON.stringify({ threadId }) })
      .catch(() => undefined)
      .finally(() => setStopping(false));
  };
  return (
    <div data-setup-request className="mb-2 flex">
      <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 ps-2.5 pe-1 text-[13px] text-ink">
        <Sparkles size={13} aria-hidden="true" className="shrink-0 text-accent-text" />
        <bdi dir="auto" className="min-w-0 truncate">{t("composer.setupRequest.waiting", { name: bot.name })}</bdi>
        <button type="button" data-setup-request-cancel="" onClick={stop} disabled={stopping}
          aria-label={t("composer.setupRequest.cancel", { name: bot.name })} title={t("composer.setupRequest.cancel", { name: bot.name })}
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink">
          <X size={12} />
        </button>
      </span>
    </div>
  );
}
