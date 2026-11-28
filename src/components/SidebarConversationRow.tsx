import { useRef, type ComponentProps } from "react";
import { useOnScreen } from "@/lib/on-screen";
import { currentTaskBot, type Bot, type InstanceInfo } from "@/state/store";
import { useSidebarRecentMessages } from "./bot-panel/Conversations";
import { lastLine } from "./sidebar-preview";
import { SidebarThreadRow } from "./SidebarThreadRow";

export function SidebarConversationRow({ bot, instances, ...props }: ComponentProps<typeof SidebarThreadRow> & { bot: Bot; instances: InstanceInfo[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(ref);
  const messages = useSidebarRecentMessages(bot, props.task, onScreen);
  const preview = messages ? lastLine(currentTaskBot(bot, props.task.threadId), messages, instances, false) : undefined;
  return <div ref={ref}><SidebarThreadRow {...props} preview={preview} /></div>;
}
