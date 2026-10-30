// Per-bot checks for phone tool calls: the phone's grant decides which apps exist, the bot's grant decides read or write.
import { PHONE_SLUG, ALL_PHONE_APPS, isPhoneToolName, isPhoneWrite, phoneToolCapability, type PhoneApps, type PhoneCapability, type PhonePlatform } from "../../shared/phone-apps.ts";
import { connectorScopeRefusalText } from "../connector-verdict.ts";
import { PHONE_PROMPT, PHONE_WITHHELD_PROMPT, type PHONE_PLACE_PROMPT } from "./instructions.ts";

export interface PhoneBot {
  id: string;
  name: string;
  phoneApps?: PhoneApps;
}

export type PhonePlace = keyof typeof PHONE_PLACE_PROMPT;

export function phoneAppsFor(bot: PhoneBot): PhoneApps {
  return bot.phoneApps ?? ALL_PHONE_APPS;
}

export interface PhoneDecisionRow {
  tool: string;
  summary?: string;
  decision: "auto-approved" | "auto-denied";
  rule: string;
}

export type PhoneAccess = { ok: true; rows: PhoneDecisionRow[] } | { ok: false; text: string; rows: PhoneDecisionRow[] };

/** calendar → "Calendar". */
export const capName = (cap: PhoneCapability) => cap[0]!.toUpperCase() + cap.slice(1);

/** PHONE_CREATE_EVENT → "Create event". */
export function describeAction(name: string): string {
  const action = name.replace(/^PHONE_/u, "").replace(/_+/gu, " ").toLowerCase();
  return action ? action[0]!.toUpperCase() + action.slice(1) : name;
}

/** The phone's grant decides existence; the bot's grant decides read/write. */
export function phoneAccess(bot: PhoneBot, allowed: Readonly<Partial<Record<PhoneCapability, string>>>, name: string): PhoneAccess {
  if (!isPhoneToolName(name)) {
    return { ok: false, text: `${name} is not a phone tool.`, rows: [{ tool: name, summary: "unknown phone tool", decision: "auto-denied", rule: "phone:unknown" }] };
  }
  const cap = phoneToolCapability(name);
  const Cap = capName(cap);
  if (!allowed[cap]) {
    return {
      ok: false,
      text: `${bot.name} can't use ${Cap} on this phone: it is not allowed in the MausBot app on the phone.`,
      rows: [{ tool: name, summary: `${Cap} is not allowed on the phone`, decision: "auto-denied", rule: `phone:${cap}:not-allowed-on-phone` }],
    };
  }
  const grant = phoneAppsFor(bot)[cap];
  const call = { kind: "tools" as const, invoked: name, names: [name] };
  if (!grant) {
    return { ok: false, text: connectorScopeRefusalText(call, "app", bot.name, `Phone ${Cap}`, describeAction(name)), rows: [{ tool: name, decision: "auto-denied", rule: `scope:${PHONE_SLUG}:${cap}:app` }] };
  }
  if (grant === "read" && isPhoneWrite(name)) {
    return { ok: false, text: connectorScopeRefusalText(call, "write", bot.name, `Phone ${Cap}`, describeAction(name)), rows: [{ tool: name, decision: "auto-denied", rule: `scope:${PHONE_SLUG}:${cap}:write` }] };
  }
  return { ok: true, rows: [{ tool: name, summary: `allowed ${name}`, decision: "auto-approved", rule: `scope:${PHONE_SLUG}:${cap}` }] };
}

/** The system prompt part: each phone, its platform and the apps this bot may use on it. Empty when there is nothing to use. */
export function phoneSystemPrompt(
  bot: PhoneBot,
  phones: ReadonlyArray<{ name: string; platform: PhonePlatform; capabilities: Partial<Record<PhoneCapability, string>> }>,
): string {
  const grants = phoneAppsFor(bot);
  if (Object.keys(grants).length === 0 || phones.length === 0) return "";
  const sentences = phones.map((phone) => {
    const apps = (Object.keys(grants) as PhoneCapability[]).filter((cap) => phone.capabilities[cap]).map((cap) => `${capName(cap)}${grants[cap] === "read" ? " (read only)" : ""}`);
    return ` ${describePhone(phone)}; this bot may use: ${apps.length ? apps.join(", ") : "nothing yet"}.`;
  });
  return PHONE_PROMPT + sentences.join("");
}

/** "Omkar's iPhone is an iPhone", or "The iPhone" when the phone is named after its kind (iOS 16+ reports "iPhone"). */
function describePhone(phone: { name: string; platform: PhonePlatform }): string {
  const kind = phone.platform === "ios" ? "iPhone" : "Android phone";
  return phone.name.trim().toLowerCase() === kind.toLowerCase() ? `The ${kind}` : `${phone.name} is an ${kind}`;
}

/** The note for a turn whose conversation may not use the phone: it exists, how to reach it, and which tools are not it. */
export function phoneWithheldPrompt(bot: PhoneBot, phones: ReadonlyArray<{ name: string; platform: PhonePlatform }>): string {
  if (Object.keys(phoneAppsFor(bot)).length === 0 || phones.length === 0) return "";
  return PHONE_WITHHELD_PROMPT + ` Paired: ${phones.map((phone) => phone.name).join(", ")}.`;
}
