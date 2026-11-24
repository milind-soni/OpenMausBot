import { isHandoff, signInCardWaits } from "../../shared/sign-in-request";
import type { Bot, Message } from "@/state/store";
import { SignInRequestCard } from "./SignInRequestCard";

/** A site sign-in card that still waits. A handoff card keeps its place in the chat, live picture and all. */
export function isPinnedSignIn(message: Message): boolean {
  return message.kind === "signin" && message.signIn !== undefined && !isHandoff(message.signIn) && signInCardWaits(message.signIn);
}

export const NO_PINNED_SIGN_INS: ReadonlySet<string> = new Set();

export type PinnedSignInCard = {
  message: Message;
  botId: string;
  botName: string;
  color?: Bot["color"];
  threadId: string;
};

export function PinnedSignInSlot({ cards }: { cards: readonly PinnedSignInCard[] }) {
  if (cards.length === 0) return null;
  return (
    <div data-pinned-sign-in-slot className="px-4 pb-3">
      <div className="chat-column flex flex-col gap-3">
        {cards.map((card) => (
          <SignInRequestCard key={card.message.id} botId={card.botId} botName={card.botName} color={card.color} threadId={card.threadId} message={card.message} stays={false} />
        ))}
      </div>
    </div>
  );
}
