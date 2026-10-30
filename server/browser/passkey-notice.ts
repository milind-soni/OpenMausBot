import { passkeyWallIn, type PasskeyWall } from "../../shared/passkey-wall.ts";
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

type Part = { type?: unknown; text?: unknown };

/** A browser tool's answer, with the passkey notice added when the page it shows is a passkey step. */
export function withPasskeyNotice(result: unknown, place: BrowserPlace): unknown {
  if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) return result;
  const content = (result as { content: Part[] }).content;
  const text = content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n");
  const wall = passkeyWallIn(text);
  return wall ? { ...result, content: [...content, { type: "text", text: passkeyNotice(wall, place) }] } : result;
}

/** For the runtime router: every engine's answers, except in the person's own Chrome (My Chrome), where their passkey works. */
export function passkeyAnnotation(place: BrowserPlace) {
  return (spec: { env: NodeJS.ProcessEnv }, result: unknown): unknown => (attachesToChrome(spec.env) ? result : withPasskeyNotice(result, place));
}
