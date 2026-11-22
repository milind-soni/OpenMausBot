import { createContext, memo, use, useContext, type Dispatch } from "react";
import { LiveToolsContext } from "@/hooks/use-live-tool-ids";
import { t } from "@/lib/i18n";
import type { MentionPeer } from "@/lib/mentions";
import { toolPlace, type EffectivePlace } from "@/lib/place";
import { userBubbleStyle } from "@/lib/user-bubble-tone";
import type { Action, AppState, Bot, ConfigStatus, Message } from "@/state/store";
import { useStoreRef } from "@/state/store-ref";
import { openRoomThread } from "@/state/thread-navigation";
import { CheckBackLine } from "./CheckBackLine";
import { HandoffChip } from "./HandoffReply";
import { TeammateChip } from "./TeammateChip";
import { ThreadChip } from "./ThreadChip";
import { ToolActivity } from "./ToolActivity";

export interface ChatRows {
  botId: string; threadId: string; botName: string; botColor: Bot["color"]; voiceId?: string;
  tts: ConfigStatus["tts"]; localVoice: boolean;
  hasMore: boolean; bots: readonly Bot[];
  mentionPeers: readonly MentionPeer[]; mentionPerson: { profileName?: string };
  speakerViewer?: string | null;
  focus: AppState["focusMessage"];
  showToolCalls: boolean;
  locale: string;
  bubbleStyle?: ReturnType<typeof userBubbleStyle>;
  dispatch: Dispatch<Action>;
  onBranch: (messageId: string) => boolean;
  conversational: boolean; simple?: boolean; canReact: boolean;
  openedAt: number;
  phone: boolean;
}

export const ChatRowsContext = createContext<ChatRows | null>(null);

export function useChatRows(): ChatRows {
  const rows = useContext(ChatRowsContext);
  if (!rows) throw new Error("a chat row outside ChatView");
  return rows;
}

export const ActivityChip = memo(function ActivityChip({ message, place = "auto" }: { message: Message; place?: EffectivePlace }) {
  const { bots, dispatch, threadId } = useChatRows(), liveTools = use(LiveToolsContext);
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} threadId={threadId} />; if (message.relay) return <TeammateChip message={message} />; if (message.checkBack) return <CheckBackLine line={message.checkBack} />;
  const comm = message.comm;
  if (comm) return <RoomHandoffChip message={message} comm={comm} bots={bots} dispatch={dispatch} threadId={threadId} />;
  return <ToolActivity tool={tool} live={liveTools.has(message.id)} place={toolPlace(tool.name, place)} source={{ threadId, messageId: message.id }} />;
});

const RoomHandoffChip = ({ message, comm, bots, dispatch, threadId }: { message: Message; comm: NonNullable<Message["comm"]>; bots: readonly Bot[]; dispatch: Dispatch<Action>; threadId: string }) => { const store = useStoreRef(); return <HandoffChip message={message} bots={bots} threadId={threadId} title={t("chat.openConversationWith", { name: comm.withName })} onClick={() => openRoomThread(dispatch, comm, store.state().groups)} />; };
