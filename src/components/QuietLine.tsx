import type { ReactNode } from "react";
import type { Message } from "@/state/store";
import { CheckBackLine } from "./CheckBackLine";
import { EduCrewLine } from "./EduCrewLine";
import { TeammateChip } from "./TeammateChip";
import { ThreadChip } from "./ThreadChip";

/** The one-line row an activity message shows instead of its tool chip, or null when it is a plain tool call. */
export function quietLine(message: Message, threadId: string): ReactNode {
  if (message.threadRef) return <ThreadChip message={message} threadId={threadId} />;
  if (message.relay) return <TeammateChip message={message} />;
  if (message.checkBack) return <CheckBackLine line={message.checkBack} />;
  if (message.eduCrew) return <EduCrewLine message={message} line={message.eduCrew} />;
  return null;
}
