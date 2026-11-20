/** The eight hex characters that stand for one place in every address of its bots (server/bot-link/protocol.ts `peerKey`). */
export function placeKey(placeId: string): string;
/** A bot's address in the other place (server/bot-link/protocol.ts `linkedId`). */
export function linkedAddress(placeId: string, botId: string): string;
