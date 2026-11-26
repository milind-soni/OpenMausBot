import type { SendTurnInput } from "../contracts.ts";

/** A turn that must run with no shell or command execution and no reads outside its working folders: a guest's, or work
 * from the person's other place while running commands here is not lent (server/bot-link/far-side.ts). */
export const shellOff = (turn: Pick<SendTurnInput, "guestConfined" | "linkLimited">): boolean => turn.guestConfined === true || turn.linkLimited === true;
