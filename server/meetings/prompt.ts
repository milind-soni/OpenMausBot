// What a bot is told about meeting notes when it can't take them here: without a cloud computer it gets no meeting tools,
// so without this line it can't say why a meeting link does nothing.

/** Why meeting notes can't start here, and the way to fix it. */
export const MEETINGS_NEED_CLOUD_COMPUTER = "Meeting notes run on a cloud computer, and none is set up here. Add a Boat key in Settings → Computers, or use MausBot Cloud.";

/** The system prompt part for a bot with the agents tools on a server with no cloud computer; nothing otherwise. */
export function meetingsUnavailablePrompt({ agentsTools, cloudComputer }: { agentsTools: boolean; cloudComputer: boolean }): string {
  if (!agentsTools || cloudComputer) return "";
  return ` You can't join online meetings to take notes here, so you have no meeting tools. When the person asks you to join a meeting or sends a meeting link, tell them in one line: ${MEETINGS_NEED_CLOUD_COMPUTER}`;
}
