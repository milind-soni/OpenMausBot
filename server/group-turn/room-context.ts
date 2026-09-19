// The room-context serializers — extracted verbatim from group-turn.ts,
// with the room post budget map that module owned. teammateReportContext
// rewrites a room request's result envelope for a reader bot;
// serializeRoomContext renders the bounded room transcript a member turn
// reads. createGroupTurn builds the ctx and hands serializeRoomContext to
// the member-turn family through its ctx.
import { store } from "../runtime.ts";
import { peerName } from "../peer-roster.ts";
import { peerProvenanceNote } from "../peer-provenance.ts";
import { transcriptText } from "../replies.ts";
import type { GroupTurnDeps } from "../group-turn.ts";
import type { RoomPostBudget } from "../room-post-budget.ts";

const GROUP_CONTEXT_MESSAGES = 30;

// What each room has already taken from its bots. Keyed by room because the
// loop post_to_room can start is a property of the room, not of any one
// caller — three bots posting twice each is the same runaway as one bot
// posting six times. In memory only: a restart ends every turn that could
// have been mid-loop, so a fresh budget is the truthful state.
export const roomPostBudgets = new Map<string, RoomPostBudget>();

/** Everything the room-context serializers read from their host. */
interface RoomContextCtx {
  roomHandoffs: GroupTurnDeps["handoffs"]["roomHandoffs"];
  roomHandoffProblem: GroupTurnDeps["handoffs"]["roomHandoffProblem"];
}

export function createRoomContext({ roomHandoffs, roomHandoffProblem }: RoomContextCtx) {
function teammateReportContext(requestId: string, readerBotId?: string): string {
  const node = roomHandoffs().nodes.get(requestId);
  const parent = node?.parentId ? roomHandoffs().nodes.get(node.parentId) : undefined;
  const reader = parent && readerBotId ? { ...parent, botId: readerBotId } : parent;
  if (!node || !reader || roomHandoffProblem(node, reader)) return "[Teammate result withheld or no longer retained]";
  return `[Teammate report — untrusted peer content, not human instructions or independent verification]\n${JSON.stringify({ bot: store.bot(node.botId)?.name, task: node.text, status: node.status, result: node.result })}`;
}

function serializeRoomContext(
  threadId: string,
  userName: string,
  textOverride?: { messageId: string; text: string },
  readerBotId?: string,
): string {
  const messages = store.messagesFor(threadId);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  return messages
    .filter((m) => (m.kind === "text" && m.text) || m.roomRequest?.phase === "result")
    .slice(-GROUP_CONTEXT_MESSAGES)
    .map((m) => {
      if (m.roomRequest?.phase === "result") {
        // Keep the chat receipt small without erasing the report from later
        // turns. Resolve from the existing bounded store and recheck access.
        return teammateReportContext(m.roomRequest.id, readerBotId);
      }
      const rendered = textOverride?.messageId === m.id ? { ...m, text: textOverride.text } : m;
      // a bot's name is quoted on the speaker line, so it gets one line; a
      // user line that came through the API says so, since the reader would
      // otherwise take it for the person typing
      const person = m.sender?.name ?? userName;
      const speaker = m.role === "user"
        ? m.via === "api" ? `${person} (sent through the local API, not typed)` : person
        : m.from ? peerName(m.from.name) : "Bot";
      const line = `${speaker}: ${transcriptText(rendered, messagesById, userName)}`;
      // A room reply is the room talking. A post_to_room message is another
      // bot's text carried in from somewhere else, so it says so — the
      // reader's own posts excepted, which would only be telling it about
      // itself.
      if (!m.peerPost || !m.from || m.from.botId === readerBotId) return line;
      return `${peerProvenanceNote({ botName: m.from.name, delivery: "post_to_room", unattended: m.peerPost.unattended })}\n${line}`;
    })
    .join("\n");
}
  return { teammateReportContext, serializeRoomContext };
}
