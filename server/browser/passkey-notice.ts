import { GOOGLE_PAGE, passkeyWallIn, type PasskeyWall } from "../../shared/passkey-wall.ts";
import { attachesToChrome } from "../browser-runtime.ts";

/** Where the bots' browsers run: only My Cloud has a person's lent PC to offer. */
export type BrowserPlace = "cloud" | "desktop" | "server";

const PROVIDER: Record<PasskeyWall, { name: string; apps: string; otherWay: string }> = {
  google: { name: "Google", apps: "Gmail, Calendar or Drive", otherWay: "Try another way" },
  microsoft: { name: "Microsoft", apps: "Outlook, Calendar, OneDrive or Teams", otherWay: "Other ways to sign in" },
};

export function passkeyNotice(wall: PasskeyWall, place: BrowserPlace): string {
  const { name, apps, otherWay } = PROVIDER[wall];
  return `Passkey step, from OpenMausBot: this ${name} account wants a passkey or security key, which lives on the person's own phone or computer. This browser has none, so it turns the request down at once and ${name} may say something went wrong: do not retry, wait, or press Continue or Try again. Choose "${otherWay}" on this page (the options can take a moment: take a snapshot to see them), or use the person's own computer's browser. What works, best first: 1) For ${apps}, use connected apps instead of this browser; if ${name} is not connected, call COMPOSIO_MANAGE_CONNECTIONS so the person can connect it. 2) If this browser must be signed in: with a saved login for this account, click "${otherWay}", choose the password and call fill_login; otherwise call request_sign_in and tell them to choose "${otherWay}" on this page, then use their password and a code (authenticator app, text message or backup code).`
    + (place === "cloud" ? " 3) If they lend a PC to My Cloud (list_shared_computers), their own browser on it can use the passkey while they approve it at that PC." : "");
}

/** Google's refusal of an automated browser ("Couldn't sign you in: this browser or app may not be secure"). */
const GOOGLE_REJECTED = /https:\/\/accounts\.google\.com\/(?:v\d+\/)?signin\/(?:v\d+\/)?rejected\b/u;
/** Its English wording: the heading, then the reason, so a page that only quotes the reason is no refusal. */
const GOOGLE_REJECTED_WORDS = /\bcouldn(?:'|’)?t sign you in\b[\s\S]{0,300}\bthis browser or app may not be secure\b/iu;

/** A page's text or a browser tool's answer: Google's refusal page, by its address or its wording on a Google page. */
export function googleRefusalIn(text: string): boolean {
  return GOOGLE_REJECTED.test(text) || (GOOGLE_REJECTED_WORDS.test(text) && GOOGLE_PAGE.test(text));
}

/** Google turns down sign-in in a browser run by software, so the bot hands that step to the person. */
export function googleRefusalNotice(place: BrowserPlace): string {
  return "Google sign-in refused, from OpenMausBot: Google does not let a browser run by software sign in, and retrying, waiting, a new tab or a fresh page will not change that: do not retry Google sign-in in this browser. Hand this step to the person. What works, best first: 1) For Gmail, Calendar or Drive, use connected apps instead of this browser; if Google is not connected, call COMPOSIO_MANAGE_CONNECTIONS so the person can connect it. 2) For a site's \"Sign in with Google\": tell the person in plain words that Google refused the bot's browser, and ask whether that site offers another way to sign in (email and password, or a link by email); with a saved login use fill_login, otherwise request_sign_in, and they choose that other way, not Google. 3) Or the person does this step in their own computer's browser."
    + (place === "cloud" ? " If they lend a PC to My Cloud (list_shared_computers), its own browser is an ordinary one, where Google sign-in usually works." : "");
}

type Part = { type?: unknown; text?: unknown };

/** A browser tool's answer, with a notice added when the page it shows is a passkey step or Google's refusal. */
export function withPasskeyNotice(result: unknown, place: BrowserPlace): unknown {
  if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) return result;
  const content = (result as { content: Part[] }).content;
  const text = content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n");
  const wall = passkeyWallIn(text);
  const notice = wall ? passkeyNotice(wall, place) : googleRefusalIn(text) ? googleRefusalNotice(place) : null;
  return notice ? { ...result, content: [...content, { type: "text", text: notice }] } : result;
}

/** For the runtime router: every engine's answers, except in the person's own Chrome (My Chrome), where their passkey and Google sign-in work. */
export function passkeyAnnotation(place: BrowserPlace) {
  return (spec: { env: NodeJS.ProcessEnv }, result: unknown): unknown => (attachesToChrome(spec.env) ? result : withPasskeyNotice(result, place));
}
