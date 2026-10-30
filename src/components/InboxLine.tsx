// On a Team Cloud: a line in the person's inbox says who it is from and where it came from, with the way back there, and
// what their assistant answered for them. An answer that came back from someone's inbox says who answered.
import { useStore, openThread, type Message } from "@/state/store";
import { isQuestionCard } from "@/lib/question-card";
import { t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import type { TeamPerson } from "@/state/team-people";
import { BotAvatar } from "./Avatar";
import { PersonFace } from "./TeamOwner";

const face = (person: { name: string; email: string }): TeamPerson => ({ email: person.email, name: person.name, role: "member" });

/** The face of who a line is from: a teammate's picture, or the bot's avatar. */
export function InboxSender({ from, size = 16 }: { from: NonNullable<Message["inbox"]>["from"]; size?: number }) {
  const { state } = useStore();
  if (from.email) return <PersonFace person={face({ name: from.name, email: from.email })} size={size} />;
  const bot = state.bots.find((one) => one.id === from.botId);
  return <BotAvatar bot={bot ?? { name: from.name, color: "blue" }} state="happy" size={size} motion="none" motionKey={0} animated={false} />;
}

/** Where an inbox line came from, as a link that opens it there; none for a line from a conversation the person can't read. */
export function useInboxOrigin(message: Pick<Message, "inbox">): { label: string; hint: string; open(): void } | undefined {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const origin = message.inbox?.origin;
  if (!origin) return undefined;
  return {
    label: t("inbox.in", { title: origin.title }),
    hint: t("inbox.openOrigin", { title: origin.title }),
    open: () => openThread(dispatch, { botId: origin.botId, threadId: origin.threadId }, state, showThreads),
  };
}

/** A question's copy, and an approval's while it waits above the composer, say where they were asked in their own
 * header. */
function headedByItsCard({ inbox, card }: Message): boolean {
  if (inbox?.kind !== "ask") return false;
  return isQuestionCard(card) || Boolean(card?.requestId && card.tool && !card.answered && !card.dismissed && !card.expired);
}

/** Above an inbox line: from whom, through which bot, and the conversation it came from. */
export function InboxCaption({ message }: { message: Message }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const item = message.inbox;
  if (!item || headedByItsCard(message)) return null;
  const who = item.assistant ? t("inbox.assistantOf", { name: item.from.name }) : t("inbox.from", { name: item.from.name });
  const origin = item.origin;
  return (
    <div data-inbox-line={item.kind} className="-mb-2 flex min-w-0 items-center gap-1.5 pl-0.5 text-[11px] text-ink-tertiary">
      <InboxSender from={item.from} />
      <span className="truncate font-medium text-ink-secondary">{who}</span>
      {item.via && <span className="shrink-0">· {t("inbox.via", { name: item.via.name })}</span>}
      {origin && (
        <button type="button" onClick={() => openThread(dispatch, { botId: origin.botId, threadId: origin.threadId }, state, showThreads)}
          aria-label={t("inbox.openOrigin", { title: origin.title })} title={t("inbox.openOrigin", { title: origin.title })}
          className="min-w-0 truncate rounded px-1 hover:bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          · {t("inbox.in", { title: origin.title })}
        </button>
      )}
    </div>
  );
}

/** Under an inbox line: what the person's assistant answered for them, which a reply corrects. */
export function InboxAnswers({ message }: { message: Message }) {
  const answers = message.inbox?.answers?.filter((answer) => answer.by === "assistant") ?? [];
  if (!answers.length) return null;
  return (
    <div data-inbox-answer className="-mt-1 flex max-w-[min(38rem,100%)] flex-col gap-0.5 rounded-xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
      <span className="text-[11px] font-medium text-ink-tertiary" title={t("inbox.assistantHint")}>{t("inbox.assistantAnswered")}</span>
      {answers.map((answer) => <p key={answer.at} className="whitespace-pre-wrap break-words">{answer.text}</p>)}
      <span className="text-[11px] text-ink-tertiary">{t("inbox.assistantHint")}</span>
    </div>
  );
}

/** Above an answer that came back from someone's inbox: who answered, or that their assistant did. */
export function RelayLabel({ message }: { message: Message }) {
  const relay = message.relay;
  if (!relay || relay.kind === "told") return null;
  return (
    <div className="mb-1 flex items-center gap-1.5 pl-0.5" data-relay={relay.kind}>
      <PersonFace person={face(relay)} size={16} />
      <span className="text-[11px] font-medium text-ink-secondary">{t(relay.kind === "assistant" ? "relay.assistant" : "relay.reply", { name: relay.name })}</span>
    </div>
  );
}
