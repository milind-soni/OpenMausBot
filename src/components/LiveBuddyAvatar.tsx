// A Buddy's avatar showing what that Buddy is doing right now: writing,
// thinking, in Preview, testing, queued in a room, waiting on you, stuck.
// Reads the stream and Preview stores itself so only this small component
// re-renders while a reply streams in.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { stateForBot, type MascotLiveContext, type MausMotion, type MausState } from "@/lib/mascot";
import { useTestingState } from "@/lib/previewTestingStore";
import { useRoomActivity, useStreaming, visibleMessages, type Bot, type Group, type Message } from "@/state/store";
import { MausAvatar } from "./Avatar";

/** How long the finished-a-turn hop shows before the Buddy settles. */
const SUCCESS_MS = 1800;

type RoomContext = Pick<MascotLiveContext, "roomBusy" | "queued" | "roomStatus">;

export type LiveBuddyAvatarProps = {
  bot: Bot;
  size: number;
  /** The messages to judge by; defaults to the Buddy's visible conversation. */
  messages?: Message[];
  /** Rooms: the room's thread, whose stream is this Buddy's while it holds the turn. */
  threadId?: string;
  room?: RoomContext;
  motion?: MausMotion;
  motionKey?: number;
  label?: string;
};

function LiveBuddyAvatarComponent({
  bot,
  size,
  messages,
  threadId,
  room,
  motion = "none",
  motionKey = 0,
  label,
}: LiveBuddyAvatarProps) {
  const { streaming, reasoning } = useStreaming();
  const { sessions } = useTestingState();
  const running = Boolean(bot.busy || room?.roomBusy);
  // Its own chat streams on its thread; in a room, on the room's while it holds the turn.
  const streams = (record: Record<string, string>) =>
    Boolean((bot.busy && record[bot.threadId]) || (room?.roomBusy && threadId && record[threadId]));
  const preview = sessions.find((session) => session.botId === bot.id) ?? null;

  const state = stateForBot(
    { ...bot, messages: messages ?? visibleMessages(bot) },
    {
      writing: streams(streaming),
      reasoning: streams(reasoning),
      preview,
      ...room,
    },
  );

  // A turn that ends cleanly gets one happy hop.
  const [celebrating, setCelebrating] = useState(false);
  const wasRunning = useRef(running);
  const settled = state !== "error" && state !== "attention" && state !== "limited";
  useEffect(() => {
    const finished = wasRunning.current && !running;
    wasRunning.current = running;
    if (finished && settled) setCelebrating(true);
  }, [running, settled]);
  useEffect(() => {
    if (!celebrating) return;
    const timer = setTimeout(() => setCelebrating(false), SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [celebrating]);

  const shown: MausState = celebrating && !running ? "success" : state;
  return (
    <MausAvatar color={bot.color} state={shown} size={size} motion={motion} motionKey={motionKey} label={label} />
  );
}

export const LiveBuddyAvatar = memo(LiveBuddyAvatarComponent);

/** A room member's avatar: judged by that member's turn, queue place and messages in the room. */
export const RoomBuddyAvatar = memo(function RoomBuddyAvatar({
  bot,
  group,
  size,
  label,
}: {
  bot: Bot;
  group: Group;
  size: number;
  label?: string;
}) {
  const activity = useRoomActivity(group.threadId)[bot.id];
  const messages = useMemo(
    () => group.messages.filter((message) => message.from?.botId === bot.id),
    [group.messages, bot.id],
  );
  return (
    <LiveBuddyAvatar
      bot={bot}
      size={size}
      label={label}
      messages={messages}
      threadId={group.threadId}
      room={{
        roomBusy: group.busyBotId === bot.id,
        queued: (group.queuedBotIds ?? []).includes(bot.id),
        roomStatus: activity?.status,
      }}
    />
  );
});
