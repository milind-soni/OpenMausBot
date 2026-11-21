/** The other bots that use this bot's named browser profile, and so share what it is signed in to. A guest browser is
 * the bot's own temporary one (server/host/browser.ts sessionFor), so it has none. */
export function browserMatesOf(bots: ReadonlyArray<{ id: string; browserProfile?: string | null }>, botId: string): string[] {
  const profile = bots.find((bot) => bot.id === botId)?.browserProfile;
  return profile && profile !== "guest" ? bots.filter((bot) => bot.id !== botId && bot.browserProfile === profile).map((bot) => bot.id) : [];
}
