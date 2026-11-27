import type { ComponentProps } from "react";

import { Composer } from "../Composer";
import { NewConversationInstead } from "../NewConversationInstead";

/** A room's composer, or, when this person can only view one of its bots, a line saying so: writing there makes every
 * bot in it answer. */
export function RoomComposer(props: ComponentProps<typeof Composer>) {
  const viewOnly = props.members?.find((bot) => bot.yourAccess === "view");
  if (viewOnly) return <NewConversationInstead bot={viewOnly} room onNew={() => {}} />;
  return <Composer {...props} />;
}
