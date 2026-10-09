// The plain line a connection card carries beside its `connector` payload.
//
// Desktop and current phones draw `kind: "connector"` as a card and never
// read this. It exists for clients that do not know the kind yet — phone
// builds from before the in-chat card shipped decode it as "unknown" and draw
// whatever `text` a message has, so without it they showed nothing at all
// while the bot sat waiting for a connection. Exports and backups read it too.
// It names the app and points at the card; it never carries a link, because
// the authorization URL is only ever handed to the person's own client.

/** "Connect GitHub to continue." — or, for a second account, the alias too. */
export function connectorCardText(label: string, alias?: string): string {
  const app = label.replace(/\s+/g, " ").trim() || "this app";
  const account = alias?.replace(/\s+/g, " ").trim();
  return account ? `Connect ${app} as “${account}” to continue.` : `Connect ${app} to continue.`;
}
