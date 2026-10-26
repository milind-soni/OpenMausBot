// A webhook automation's private address, given to the bot that owns it (or a Chief of Staff that manages that bot) so
// it can set up the app that sends to it. Never in a turn a guest or an outside event drives: event data must not be able
// to fetch the address and send it on. It travels only in that tool result; transcripts and logs mask it (shared/redact.ts).
import { canManage, type RosterMember } from "./peer-roster.ts"; import { chiefLevel } from "./chief-level.ts";
import { webhookCredential } from "./webhook-ingress.ts";
import type { WebhookManager } from "./webhooks.ts";

export interface AddressAsk {
  from: RosterMember;
  owner: RosterMember;
  /** A Cloud turn its owner did not drive. */
  guestDriven: boolean;
  /** A run a webhook or app event started, or work one handed on. */
  outsideDriven: boolean;
}

export type WebhookAddress = { url: string; endpoint: string; bearer: string; note: string } | { unavailable: string };

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//u;

export function addressRefusal(ask: AddressAsk): string | null {
  if (ask.guestDriven) return "Only the Cloud's owner gets an automation's address. Tell the person to ask from their own conversation.";
  if (ask.outsideDriven) return "A run that an outside event started never gets an automation's address. If it is needed, the person can ask in their own chat.";
  if (ask.from.id === ask.owner.id || (chiefLevel(ask.from) && canManage(ask.from, ask.owner))) return null;
  return `Only ${ask.owner.name}, which owns this automation, or a Chief of Staff gets its address.`;
}

/** Null when no webhook has that id. A webhook from before addresses were kept that an app already reached stays unreadable. */
export function webhookAddress(webhooks: Pick<WebhookManager, "currentSecret">, id: string, baseUrl: string): WebhookAddress | null {
  const current = webhooks.currentSecret(id, true);
  if (!current) return null;
  if (!current.secret) {
    return { unavailable: "This automation's address was made before OpenMausBot kept addresses, and an app already sends to it, so it can't be shown again. Ask the person to use Copy address on the automation's card, or Replace address there for a new one." };
  }
  const credential = webhookCredential(baseUrl, current.webhook.endpointId, current.secret);
  const local = LOOPBACK.test(credential.endpointUrl) ? " This address is on this computer, so only apps running on it can reach it." : "";
  return {
    url: credential.url,
    endpoint: credential.endpointUrl,
    bearer: credential.secret,
    note: `Paste url into the setup of the app that sends to this automation, and nowhere else: never repeat it in chat, notes, files or messages to other bots. An app that can't take the full address sends to endpoint with the header "Authorization: Bearer <bearer>".${local}`,
  };
}

/** The address for a create_trigger result or a list_triggers request: the address, or why this turn does not get it. */
export function addressFor(ask: AddressAsk, webhooks: Pick<WebhookManager, "currentSecret">, id: string, baseUrl: string):
  { address: WebhookAddress } | { addressRefused: string } | Record<string, never> {
  const refused = addressRefusal(ask);
  if (refused) return { addressRefused: refused };
  const address = webhookAddress(webhooks, id, baseUrl);
  return address ? { address } : {};
}
