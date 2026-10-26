// No imports: harness-mcp-proxy bundles this file into the agent process.

/** tools/list instructions for the device MCP server. */
export const PHONE_INSTRUCTIONS =
  "The PHONE tools reach the person's own phone: the apps they allowed in the MausBot app (calendar, reminders, contacts, location, home, messages). " +
  "Reads need no permission and are free; use them to look before you act. Every write is shown in the chat as it happens. " +
  "PHONE_SEND_MESSAGE and PHONE_SEND_WHATSAPP never send by themselves: they open a sheet on the phone and the message goes only when the person taps Send, so say that it is waiting for them. " +
  "Pass ids from earlier results, never guessed ones. Dates are ISO 8601 strings with an offset. When more than one phone is paired, name the phone with the optional phone argument. " +
  "If the phone is offline, ask the person to open MausBot on it. " +
  "After a failure or an unknown outcome, read the record back with the matching PHONE_GET_ or PHONE_LIST_ tool before repeating a write, and never repeat a send.";

/** The system prompt part for a bot whose turn mounts the device tools. */
export const PHONE_PROMPT =
  " The person's own phone is reachable through the PHONE tools (calendar, reminders, contacts, location, home and messages), limited to the apps they allowed on that phone and to what this bot was granted. " +
  "Reads need no permission; every change you make is shown in the chat. A message is only sent when the person taps Send on the phone, so never claim it was sent. " +
  "If the phone is offline, ask the person to open MausBot on it. " +
  "The phone tools named mcp__phone__ are something else: they drive an Android phone plugged into the computer over USB, never the person's own phone above.";

/** Where the person is this turn, decided by where the turn came from, never by asking: on their phone (do it there), at the
 * computer (the usual way, the phone only when they name it), or nowhere (a run nobody waits on). */
export const PHONE_PLACE_PROMPT: Readonly<Record<"phone" | "computer" | "unattended", string>> = {
  phone: " The person is talking to you from their phone right now. When they ask for a reminder, an event, a contact, their location or a text, do it on the phone with the PHONE tools, as far as the phone allows.",
  computer: " The person is at their computer right now, so do things the usual way here. Reading their phone (calendar, reminders, contacts, location) is fine when it helps. " +
    "Create or change something on the phone, or send a text from it, only when they name the phone; otherwise do it here.",
  unattended: " Nobody is waiting on this turn. Use the PHONE tools only when the task itself names the phone.",
};

/** When this conversation may not use the phone (routines, webhooks or other people have written into it). */
export const PHONE_WITHHELD_PROMPT =
  " The person has paired a phone, but its apps are not available in this conversation because routine reports, webhooks or other people have written into it. " +
  "If they ask for something on their phone, tell them to ask you in a new conversation, where you can use it. " +
  "Do not use the mcp__phone__ tools for it: those drive an Android phone plugged in over USB, not their phone.";

/** The failed-call recovery sentence for the device kind. */
export const PHONE_RECOVERY =
  " The phone may or may not have taken the change; read it back (PHONE_GET_EVENT, PHONE_LIST_REMINDERS, PHONE_GET_CONTACT) before repeating a write, and never repeat a send.";

export const PHONE_NO_PHONE_TEXT = "No phone is paired with its apps allowed. Ask the person to open MausBot on their phone and allow apps under Settings.";
