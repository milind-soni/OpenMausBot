// fill_login for one turn: filled by the server as one browser action, answered with a status in words, never a value.
import type { Surface } from "../../shared/wire.ts";
import type { BotLogins } from "../bot-logins.ts";
import { BROWSER_CONTROL_REFUSAL } from "../browser-runtime.ts";
import type { StepContext } from "../browser-steps.ts";
import { fillLogin, type FillLoginDeps, type FillLoginOutcome } from "../login-fill.ts";
import { redactSecretsInText } from "../redact.ts";
import type { BotRecord } from "../store.ts";
import { surfaceLabel } from "../surface.ts";

type Spec = { command: string; env: Record<string, string> };
type Turn = { botId: string; threadId: string; generation: string };
type Answer = { ok: boolean; text: string };

export interface FillLoginTurnDeps {
  place(bot: BotRecord, threadId: string): Surface | null;
  current(bot: BotRecord, threadId: string): BotRecord;
  builtInBrowserOn(): boolean;
  /** The bot's own browser can be this conversation's place on its next turn. */
  browserSelectable(bot: BotRecord): boolean;
  /** Continues this request in the bot's own browser once the turn ends; false when this turn cannot move. */
  moveToBrowser(turn: Turn): boolean;
  /** The bot's browser profile is the person's own Chrome. */
  myChrome(bot: BotRecord): boolean;
  /** Null while the browser engine is not installed. */
  target(bot: BotRecord, threadId: string): Promise<{ session: string; spec: Spec; env: NodeJS.ProcessEnv } | null>;
  claim(turn: Turn, resource: string): boolean;
  withSecretInput(session: string, spec: Spec, fill: () => Promise<FillLoginOutcome>, ctx: StepContext): Promise<FillLoginOutcome>;
  logins: Pick<BotLogins, "candidates" | "sitesFor" | "markUsed">;
  /** Why 1Password's logins may be missing just now. */
  onePasswordTrouble(): string | undefined;
  loginInput(session: string, spec: Spec, env: NodeJS.ProcessEnv): Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click">;
  remember: FillLoginDeps["remember"];
  stepContext(bot: BotRecord, turn: Turn): StepContext;
}

const ONLY_IN_BROWSER = "fill_login types a password only into a page of your own browser, where OpenMausBot checks the page's site first";

export function createFillLoginTurn(deps: FillLoginTurnDeps) {
  // Security: on a screen the server cannot prove which site a focused box belongs to, so a secret is never typed there.
  function elsewhere(bot: BotRecord, turn: Turn, place: Surface | null): Answer {
    const current = deps.current(bot, turn.threadId);
    const where = place ? surfaceLabel(place) : null;
    const notHere = where ? `; it never types one on the screen of ${where}` : "";
    const signIn = where ? `Call request_sign_in so the person signs in on ${where}.` : "Call request_sign_in instead.";
    if (!deps.browserSelectable(current)) {
      const why = current.browser === false || current.computer === "off" || !deps.builtInBrowserOn()
        ? "the built-in browser is off for you here"
        : "your browser is not available here: it is not installed yet, or this AI model cannot use browser tools";
      return { ok: false, text: where ? `${ONLY_IN_BROWSER}${notHere}, and ${why}. ${signIn}` : `fill_login works in the built-in browser, and this conversation has none. ${signIn}` };
    }
    if (!deps.logins.sitesFor(bot.id).length) {
      const trouble = deps.onePasswordTrouble();
      return { ok: false, text: `You have no saved logins to fill${trouble ? ` (1Password could not be read just now: ${trouble})` : ""}. ${signIn}` };
    }
    if (!deps.moveToBrowser(turn)) {
      return { ok: false, text: `${ONLY_IN_BROWSER}${notHere}, and this run cannot move to your browser. ${signIn} For runs like this to sign in by themselves, the person can choose Browser under where this bot works.` };
    }
    const chrome = deps.myChrome(current) ? ", which is the person's own Chrome (My Chrome), signed in as them" : "";
    return { ok: false, text: `${ONLY_IN_BROWSER}${notHere}. OpenMausBot is moving this conversation to your own browser${chrome}. End this turn now without using the screen tools: the request continues there with your browser tools. Open the site's sign-in page in that browser, then call fill_login.` };
  }

  async function fillLoginForTurn(bot: BotRecord, capability: Turn, rawUsername: unknown, rawSubmit: unknown): Promise<Answer> {
    const threadId = capability.threadId;
    const place = deps.place(bot, threadId);
    if (place !== "browser") return elsewhere(bot, capability, place);
    const current = deps.current(bot, threadId);
    if (current.browser === false || current.computer === "off" || !deps.builtInBrowserOn()) {
      return { ok: false, text: "The built-in browser is off for you here, so fill_login has nothing to fill. Call request_sign_in instead." };
    }
    const browser = await deps.target(current, threadId);
    if (!browser) return { ok: false, text: "The browser is not available on this computer right now. Call request_sign_in instead." };
    const { session, spec, env } = browser;
    if (!deps.claim(capability, `browser:${session}`)) {
      return { ok: false, text: "Another conversation is using this browser. Wait until it finishes, then call fill_login again." };
    }
    const username = typeof rawUsername === "string" ? rawUsername.slice(0, 512) : undefined;
    try {
      const outcome = await deps.withSecretInput(session, spec, () => fillLogin({
        username,
        submit: rawSubmit !== false,
        candidates: (host) => deps.logins.candidates(bot.id, host),
        available: async () => deps.logins.sitesFor(bot.id),
        trouble: deps.onePasswordTrouble,
      }, {
        ...deps.loginInput(session, spec, env),
        remember: deps.remember,
      }), deps.stepContext(current, capability));
      if (outcome.ok && outcome.loginId) deps.logins.markUsed(outcome.loginId);
      return { ok: outcome.ok, text: outcome.text };
    } catch (error) {
      if (error instanceof Error && error.message === BROWSER_CONTROL_REFUSAL) {
        return { ok: false, text: "The person is using this browser right now. Wait for them to hand it back, then call fill_login again." };
      }
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, text: `Could not fill the login: ${redactSecretsInText(reason)} Call request_sign_in if it keeps failing.` };
    }
  }

  return { fillLoginForTurn };
}
