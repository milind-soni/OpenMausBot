import type { Bot, Message } from "@/state/store";
import { BotAvatar, InitialsAvatar } from "./Avatar";

type CommIdentity = NonNullable<Message["comm"]>;

export function CommActivityAvatar({
  bots,
  comm,
  size = 16,
}: {
  bots: Bot[];
  comm: CommIdentity;
  size?: number;
}) {
  const peer = bots.find((bot) => bot.id === comm.withBotId);

  if (peer) {
    return (
      <BotAvatar
        bot={peer}
        state="happy"
        size={size}
        animated={false}
        label={`${peer.name} avatar`}
      />
    );
  }

  const initial = comm.withName.trim().charAt(0).toUpperCase() || "?";
  return <InitialsAvatar initials={initial} size={size} />;
}
