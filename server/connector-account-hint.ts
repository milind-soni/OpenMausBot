// A connected app can have more than one connected account. A call that names one the app's installation cannot reach
// is refused for lack of access, and GitHub's answer for that is "Resource not accessible by integration": the wording
// of an app closed to the bot, not of one account closed to another. Composio refuses a call that names no account at
// all ("Multiple github accounts connected. Specify which to use via the 'account' field"), so the account is always
// the bot's own choice, and a refusal it gets back reads as a wall. The scope hint already turns a failed call into
// something the bot can act on; this one names the other accounts of the same app, so the bot tries them before it
// tells the person it has no access.

import { toolkitOf } from "../shared/connector-scopes.ts";
import { annotateFailedCall } from "./connector-scope-hint.ts";

/** GitHub's wording when the connected account's app installation cannot reach what the call asks for. */
const ACCOUNT_ERROR = /not accessible by integration/i;

/** Composio's wording when a call names no account and the app has more than one connected account. The tool schema
 * calls the account field optional, so a bot that has one account in mind leaves it out and the call fails wholesale. */
const MISSING_ACCOUNT_ERROR = /multiple .* accounts connected/i;

/** Marks the note a frame carries, so a frame that must not get one can be told from one that does. */
const NOTE = "\u0000omb-account-hint:";

/** A connected account of one app, as the services inventory gives it. */
export interface ConnectedAccount {
  id: string;
  alias?: string;
  status: string;
}

/** The accounts of every connected app, by app slug. */
export type ConnectedAccounts = Record<string, readonly ConnectedAccount[]>;

function appName(toolkit: string): string {
  if (toolkit === "gmail") return "Gmail";
  if (toolkit === "github") return "GitHub";
  if (toolkit === "slack") return "Slack";
  if (toolkit === "notion") return "Notion";
  if (toolkit.startsWith("google")) return "Google";
  return toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
}

/** The accounts of one app that can run a call now. */
function usable(accounts: ConnectedAccounts, toolkit: string): readonly ConnectedAccount[] {
  return (accounts[toolkit] ?? []).filter((account) => /^active$/i.test(account.status));
}

/** The app the slugs name, when they all name the same one. A batch that mixes apps names none: a refusal that does
 * not say which app it is about must not be answered with another app's accounts. */
function oneToolkit(slugs: readonly string[]): string | undefined {
  const toolkits = new Set(slugs.filter((slug) => slug && !slug.startsWith("COMPOSIO_")).map(toolkitOf));
  return toolkits.size === 1 ? [...toolkits][0] : undefined;
}

/** The note for a call refused on the account it used: the other accounts of that app, by alias or id. */
export function accountHint(slugs: readonly string[], accounts: ConnectedAccounts): string {
  const toolkit = oneToolkit(slugs);
  if (!toolkit) return "";
  const known = usable(accounts, toolkit);
  if (known.length < 2) return "";
  const app = appName(toolkit);
  const names = known.map((account) => account.alias?.trim() || account.id).join(", ");
  return `OpenMausBot note: ${app} refused this because the connected account the call used cannot reach it. `
    + `That is about that account, not about a lack of access to ${app}: ${app} has ${known.length} connected accounts (${names}). `
    + `Name another one in the call's account field (an alias or an id) and try it once, `
    + `before telling the person you have no access to ${app}.`;
}

/** The note for a call refused because it named no account and the app has more than one connected account: the
 * accounts the bot can use, by alias or id, so the model names one and retries instead of failing the task. */
export function missingAccountHint(slugs: readonly string[], accounts: ConnectedAccounts): string {
  const toolkit = oneToolkit(slugs);
  if (!toolkit) return "";
  const known = usable(accounts, toolkit);
  if (!known.length) return "";
  const app = appName(toolkit);
  const names = known.map((account) => account.alias?.trim() || account.id).join(", ");
  if (known.length === 1)
    return `OpenMausBot note: ${app} refused this because the call named no account and ${app} has more than one `
      + `connected account, of which one can run a call (${names}). Name that one in the call's account field `
      + `(an alias or an id) and try the call again.`;
  return `OpenMausBot note: ${app} refused this because the call named no account and ${app} has ${known.length} `
    + `connected accounts (${names}). Name one of them in the call's account field (an alias or an id) and try the `
    + `call again.`;
}

/** The refusals a note answers, and the note for each: an account the call used cannot reach it, or the call named no
 * account at all and the app has more than one. A refusal both name answers with the first note. */
const NOTES: readonly (readonly [RegExp, (slugs: readonly string[], accounts: ConnectedAccounts) => string])[] = [
  [ACCOUNT_ERROR, accountHint],
  [MISSING_ACCOUNT_ERROR, missingAccountHint],
];

/** The accounts of every app, as the services inventory gives them. */
export function accountsByApp(services: Record<string, { accounts: readonly ConnectedAccount[] }>): ConnectedAccounts {
  return Object.fromEntries(Object.entries(services).map(([slug, state]) => [slug, state.accounts]));
}

/** Takes the mark out of a frame: the note stays as it is, and a frame that earned none loses the mark again.
 * Tells whether the frame carries a note. */
function unmarked(frame: unknown): boolean {
  const content = (frame as { result?: { content?: unknown } } | null)?.result?.content;
  if (!Array.isArray(content) || !content.length) return false;
  const last = content[content.length - 1] as { text?: unknown };
  if (typeof last.text !== "string" || !last.text.startsWith(NOTE)) return false;
  const note = last.text.slice(NOTE.length);
  if (!note) content.pop();
  else last.text = note;
  return Boolean(note);
}

/** Adds the account note to a call refused for the account it used, when that app has another account to try.
 * Every frame of an answer gets the note of the app its own refusal names. */
export async function withAccountHint(
  bytes: Uint8Array,
  contentType: string,
  slugs: readonly string[],
  loadAccounts: () => Promise<ConnectedAccounts>,
): Promise<Uint8Array> {
  const text = new TextDecoder().decode(bytes);
  const matched = NOTES.find(([pattern]) => pattern.test(text));
  if (!matched) return bytes;
  const [pattern, noteFor] = matched;
  const accounts = await loadAccounts().catch(() => ({}) as ConnectedAccounts);
  // The shared helper hands the hint the tools that frame names, so the note is the one of that frame's own app.
  const hint = (failed: readonly string[]) => `${NOTE}${noteFor(failed, accounts)}`;
  let noted = false;
  try {
    if (/text\/event-stream/i.test(contentType)) {
      const lines = text.split("\n").map((line) => {
        if (!line.startsWith("data:")) return line;
        const frame = JSON.parse(line.slice(5));
        if (!annotateFailedCall(frame, pattern, hint, slugs)) return line;
        noted = unmarked(frame) || noted;
        return `data: ${JSON.stringify(frame)}`;
      });
      return noted ? new TextEncoder().encode(lines.join("\n")) : bytes;
    }
    const frame = JSON.parse(text);
    if (!annotateFailedCall(frame, pattern, hint, slugs)) return bytes;
    if (!unmarked(frame)) return bytes;
    return new TextEncoder().encode(JSON.stringify(frame));
  } catch {
    return bytes;
  }
}
