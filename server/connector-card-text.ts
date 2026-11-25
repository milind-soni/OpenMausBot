// The words a connect card and a sign-in card carry, in the language of the person they are for
// (server/server-lines.ts). `text` is for clients that don't know `kind: "connector"` or "signin" yet (older phones
// draw `text`), exports and backups. It never carries a link: the authorization URL is only ever handed to the
// person's own client.
import { serverLine } from "./server-lines.ts";

const oneLine = (text: string | undefined) => text?.replace(/\s+/g, " ").trim() ?? "";

/** "Connect GitHub to continue." — or, for a second account, the alias too. */
export function connectorCardText(label: string, alias?: string, language?: string): string {
  const app = oneLine(label) || serverLine(language, "server.connect.thisApp");
  const account = oneLine(alias);
  return account ? serverLine(language, "server.connect.cardAs", { app, account }) : serverLine(language, "server.connect.card", { app });
}

/** What a connect card asks for when the app's catalog says nothing of its own. */
export function connectorCardDescription(label: string, alias: string | undefined, language: string | undefined): string {
  return alias ? serverLine(language, "server.connect.descriptionAs", { app: label, account: alias })
    : serverLine(language, "server.connect.description", { app: label });
}

/** The line under a sign-in card, and all a client that does not know the card draws. */
export function signInCardText(botName: string, site: string, language?: string): string {
  return serverLine(language, "server.connect.signInCard", { bot: botName, site });
}

/** An MCP server's Sign in card: the line a client that does not draw the card shows, naming the server. */
export function mcpSignInCardText(label: string, language?: string): string {
  return serverLine(language, "server.mcp.signIn.card", { label });
}

/** What an MCP server's Sign in card asks, and why. */
export function mcpSignInCardDescription(bot: string, label: string, host: string, language?: string): string {
  return serverLine(language, "server.mcp.signIn.description", { bot, label, host });
}
