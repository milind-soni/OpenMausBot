// A connected app can have more than one connected account. A call that names one the app's installation cannot reach
// is refused for lack of access, and GitHub's answer for that is "Resource not accessible by integration": the wording
// of an app closed to the bot, not of one account closed to another. Composio refuses a call that names no account at
// all ("Multiple github accounts connected. Specify which to use via the 'account' field"), so the account is always
// the bot's own choice, and a refusal it gets back reads as a wall. The scope hint already turns a failed call into
// something the bot can act on; this one names the other accounts of the same app, so the bot tries them before it
// tells the person it has no access.

import { withFailedCallHint } from "./connector-scope-hint.ts";

/** GitHub's wording when the connected account's app installation cannot reach what the call asks for. */
const ACCOUNT_ERROR = /not accessible by integration/i;

/** What a first pass leaves in a copy of the answer, so the second pass knows which tool the refusal is about. */
const PROBE = "omb-account-hint-probe:";

/** A connected account of one app, as the services inventory gives it. */
export interface ConnectedAccount {
  id: string;
  alias?: string;
  status: string;
}

/** The accounts of every connected app, by app slug. */
export type ConnectedAccounts = Record<string, readonly ConnectedAccount[]>;

/** The app a Composio tool slug belongs to: the part before the first underscore, lower case. */
export function toolkitOf(slug: string): string {
  const cut = slug.indexOf("_");
  return (cut > 0 ? slug.slice(0, cut) : slug).toLowerCase();
}

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

/** The accounts of every app, as the services inventory gives them. */
export function accountsByApp(services: Record<string, { accounts: readonly ConnectedAccount[] }>): ConnectedAccounts {
  return Object.fromEntries(Object.entries(services).map(([slug, state]) => [slug, state.accounts]));
}

/** The tools the refusal is about, read out of a copy of the answer the shared helper annotated: the tools it names,
 * or the whole call when it names none. */
function failedTools(bytes: Uint8Array, contentType: string, slugs: readonly string[]): readonly string[] {
  const probe = withFailedCallHint(bytes, contentType, ACCOUNT_ERROR, (failed) => `${PROBE}${failed.join(",")}|`, slugs);
  const text = new TextDecoder().decode(probe);
  const at = text.indexOf(PROBE);
  if (at < 0) return [];
  const end = text.indexOf("|", at);
  return text.slice(at + PROBE.length, end < 0 ? undefined : end).split(",").filter(Boolean);
}

/** Adds the account note to a call refused for the account it used, when that app has another account to try. */
export async function withAccountHint(
  bytes: Uint8Array,
  contentType: string,
  slugs: readonly string[],
  loadAccounts: () => Promise<ConnectedAccounts>,
): Promise<Uint8Array> {
  if (!ACCOUNT_ERROR.test(new TextDecoder().decode(bytes))) return bytes;
  const accounts = await loadAccounts().catch(() => ({}) as ConnectedAccounts);
  // The note names the app the refusal is about: the tool the answer names, or the whole call when it names one app.
  const note = accountHint(failedTools(bytes, contentType, slugs), accounts);
  // Nothing to say when that app has no other account to try, or when the answer does not say which app it is about.
  if (!note) return bytes;
  return withFailedCallHint(bytes, contentType, ACCOUNT_ERROR, () => note, slugs);
}
