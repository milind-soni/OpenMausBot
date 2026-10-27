// The bot never holds the password: in-page scripts carry no secret and answer booleans, values go in as real typing over
// the engine's loopback relay (never on a command line), and the bot hears what was filled or why not, never a value.
import { randomBytes } from "node:crypto";

import { loginLabel, loginOriginCheck, loginPageCheck, type LoginPlace, type LoginSource } from "../shared/logins.ts";
import { scrubHeldSecrets } from "../shared/redact.ts";
import type { SecretHold } from "./browser-secret-hold.ts";
import { totpCode, type TotpKey } from "./totp.ts";

/** Its secrets are read only when it is about to be filled. */
export interface FillCandidate extends LoginPlace {
  id: string;
  username: string;
  source: LoginSource;
  secrets(): Promise<{ password: string; totp: TotpKey | null }>;
}

export interface FillLoginDeps {
  engine(args: string[]): Promise<Record<string, unknown> | null>;
  insertText(text: string): Promise<void>;
  /** A key pressed at the focused element, as real input. */
  press(key: string): Promise<void>;
  /** A real click on the element a CSS selector names. */
  click(selector: string): Promise<void>;
  remember(value: string, kind: "password" | "code"): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FillLoginInput {
  username?: string;
  /** Submit what was filled; false leaves that to the bot. */
  submit?: boolean;
  candidates(pageHost: string): Promise<FillCandidate[]>;
  available(): Promise<Array<LoginPlace & { username: string }>>;
  /** Why 1Password's logins may be missing just now. */
  trouble?(): string | undefined;
}

export type FilledField = "username" | "password" | "code";

export interface FillLoginOutcome {
  ok: boolean;
  /** What the bot is told. Never a value. */
  text: string;
  host?: string;
  loginId?: string;
  filled?: FilledField[];
  held?: SecretHold;
}

/** How long a filled secret may stay on a page before it is cleared, with page scripts refused there meanwhile. */
export const SECRET_HOLD_MS = 60_000;
const ENTER_WAIT_MS = 2_000;
const OUTCOME_WAIT_MS = 8_000;
const NEXT_STEP_WAIT_MS = 10_000;
const FILL_BUDGET_MS = 25_000;
const POLL_MS = 250;
const MAX_STEPS = 3;

const MARK = "data-omb-login";

// Shared by every page script: what a person could see, which fields this fill marked, a site's error line, a CAPTCHA.
const PAGE_HELPERS = `
  const MARK = ${JSON.stringify(MARK)};
  const visible = (el) => {
    if (!(el instanceof Element) || !el.isConnected || el.getClientRects().length === 0) return false;
    for (let node = el; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
    }
    return true;
  };
  const marked = (prefix) => Array.from(document.querySelectorAll("[" + MARK + "]")).filter((el) => (el.getAttribute(MARK) || "").startsWith(prefix));
  const secretField = (el) => /:(?:password|code\\d+)$/.test(el.getAttribute(MARK) || "");
  const alertText = () => {
    for (const el of document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"], .error, .alert, [class*="error" i]')) {
      if (!visible(el) || el.querySelector("input, select, textarea")) continue;
      const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      if (text && text.length <= 300) return text.slice(0, 200);
    }
    return "";
  };
  // A page sending a login by script shows no submit event: it marks itself busy or disables the form's submit control.
  const sending = (fields) => {
    const form = fields.map((el) => el.form).find(Boolean);
    const controls = form ? Array.from(form.querySelectorAll("button, input[type=submit], input[type=image]")).filter((el) => el.type === "submit" || el.type === "image") : [];
    return Boolean(document.querySelector('[aria-busy="true"]')) || controls.some((el) => el.disabled);
  };
  const humanCheck = () => Array.from(document.querySelectorAll("iframe")).some((frame) => {
    const src = frame.getAttribute("src") || "";
    if (!/recaptcha|hcaptcha|challenges\\.cloudflare\\.com|arkoselabs|funcaptcha/i.test(src) || /size=invisible|checkbox-invisible/i.test(src)) return false;
    const box = frame.getBoundingClientRect();
    return visible(frame) && box.width > 100 && box.height > 60;
  });
`;

// Marks this step's username, password and one-time-code boxes `<nonce>:<step>:<name>`; marks an earlier step left stay,
// so a failure can still clear them.
const FIND_FIELDS = `((nonce, step) => {
  ${PAGE_HELPERS}
  const key = nonce + ":" + step + ":";
  for (const old of document.querySelectorAll("[" + MARK + "]")) {
    const owner = old.getAttribute(MARK) || "";
    if (!owner.startsWith(nonce + ":") || owner.startsWith(key)) old.removeAttribute(MARK);
  }
  const usable = (el) => el instanceof HTMLInputElement && !el.disabled && !el.readOnly && el.type !== "hidden" && visible(el);
  const tokens = (el) => (el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
  const hint = (el) => [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, el.getAttribute("autocomplete")].join(" ").toLowerCase();
  const plain = (el) => el.type === "text" || el.type === "email" || el.type === "tel";
  // A strong hint makes even a password-type box a code box; a weak one
  // ("verify", "code") only a plain one, so a sign-up form's "verify
  // password" box is never taken for a code.
  const STRONG = /(?:^|[^a-z])t?otp|2fa|mfa|two[-_ ]?factor|one[-_ ]?time/;
  const WEAK = /verif|security[-_ ]?code|auth\\w*[-_ ]?code|passcode|\\bcode\\b/;
  const NOT_CODE = /zip|postal|promo|coupon|country|area|invite|referr/;
  const isCode = (el) => tokens(el).includes("one-time-code") ||
    ((plain(el) || el.type === "number" || el.type === "password") && STRONG.test(hint(el)) && !NOT_CODE.test(hint(el))) ||
    ((plain(el) || el.type === "number") && WEAK.test(hint(el)) && !NOT_CODE.test(hint(el)));
  const inputs = Array.from(document.querySelectorAll("input")).filter(usable);
  const codes = inputs.filter(isCode);
  const rest = inputs.filter((el) => !codes.includes(el));
  const passwords = rest.filter((el) => el.type === "password" && !tokens(el).includes("new-password"));
  const password = passwords.find((el) => tokens(el).includes("current-password")) || passwords[0] || null;
  const USER = /user|e-?mail|login|account|identifier|phone|mobile/;
  const userLike = (el) => tokens(el).includes("username") || tokens(el).includes("email") || el.type === "email" || (plain(el) && USER.test(hint(el)));
  let username = null;
  if (password) {
    const scope = rest.filter((el) => el !== password && plain(el) && (password.form ? el.form === password.form : !el.form));
    const before = scope.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    username = before.filter(userLike).pop() || before.pop() || scope.find(userLike) || null;
  } else {
    username = rest.find((el) => tokens(el).includes("username")) || rest.find((el) => plain(el) && userLike(el)) || null;
  }
  let boxes = [];
  if (codes.length) {
    const first = codes[0];
    const near = (el) => el.parentElement === first.parentElement || (el.parentElement && first.parentElement && el.parentElement.parentElement === first.parentElement.parentElement);
    const group = first.maxLength === 1 ? inputs.filter((el) => el.maxLength === 1 && near(el)) : [];
    boxes = group.length >= 4 ? group : [first];
  }
  if (username) username.setAttribute(MARK, key + "username");
  if (password) password.setAttribute(MARK, key + "password");
  boxes.forEach((el, index) => el.setAttribute(MARK, key + "code" + index));
  return JSON.stringify({ href: location.href, username: Boolean(username), password: Boolean(password), code: boxes.length, human: humanCheck(), alert: alertText() });
})`;

/** "type" empties the field the way typing over it would, so a React-style form's state follows; "submit" only focuses it,
 * and listens for the form being sent. */
const FOCUS_FIELD = `((nonce, key, mode, keep) => {
  ${PAGE_HELPERS}
  const el = document.querySelector("[" + MARK + "=\\"" + key + "\\"]");
  if (!(el instanceof HTMLInputElement)) return JSON.stringify({ href: location.href, focused: false, same: false });
  if (mode === "type" && typeof keep === "string" && el.value === keep) return JSON.stringify({ href: location.href, focused: true, same: true });
  if (mode === "submit" && !window["__ombLogin" + nonce]) {
    const sent = window["__ombLogin" + nonce] = { submitted: false, leaving: false };
    addEventListener("submit", () => { sent.submitted = true; }, true);
    addEventListener("beforeunload", () => { sent.leaving = true; }, true);
  }
  try { el.scrollIntoView({ block: "center" }); } catch {}
  el.focus();
  if (mode === "type" && el.value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const busy = mode === "submit" && sending(marked(nonce + ":").filter((field) => field instanceof HTMLInputElement));
  return JSON.stringify({ href: location.href, focused: document.activeElement === el, same: false, busy });
})`;

const CHECK_FIELDS = `((key) => {
  ${PAGE_HELPERS}
  const out = {};
  for (const el of marked(key)) out[(el.getAttribute(MARK) || "").slice(key.length)] = typeof el.value === "string" && el.value.length > 0;
  return JSON.stringify(out);
})`;

/** The form's own submit button first, else a button named for signing in anywhere on the page. */
const MARK_SUBMIT = `((key) => {
  ${PAGE_HELPERS}
  const fields = marked(key).filter((el) => el instanceof HTMLInputElement);
  const field = fields.find((el) => /:password$/.test(el.getAttribute(MARK) || "")) || fields[fields.length - 1];
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").replace(/\\s+/g, " ").trim();
  const NAMED = /^(?:sign ?in|log ?in|log ?on|sign ?on|continue|next|submit|verify|confirm)$/i;
  const enabled = (el) => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true";
  const inForm = field && field.form
    ? Array.from(field.form.querySelectorAll("button, input[type=submit], input[type=image]")).filter((el) => enabled(el) && (el.type === "submit" || el.type === "image"))
    : [];
  const control = inForm.find((el) => NAMED.test(label(el))) || inForm[0] ||
    Array.from(document.querySelectorAll('button, [role="button"], input[type=submit], input[type=button]')).find((el) => enabled(el) && NAMED.test(label(el)));
  if (!control) return JSON.stringify({ found: false });
  control.setAttribute(MARK, key + "submit");
  return JSON.stringify({ found: true });
})`;

const PAGE_STATE = `((nonce) => {
  ${PAGE_HELPERS}
  const ours = marked(nonce + ":").filter((el) => el instanceof HTMLInputElement);
  const sent = window["__ombLogin" + nonce] || {};
  return JSON.stringify({
    href: location.href, title: document.title, present: ours.some(visible), busy: sending(ours),
    submitted: sent.submitted === true, leaving: sent.leaving === true, alert: alertText(), human: humanCheck(),
  });
})`;

const CLEAR_SECRETS = `((nonce) => {
  ${PAGE_HELPERS}
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  let cleared = 0;
  for (const el of marked(nonce + ":")) {
    if (!(el instanceof HTMLInputElement) || !secretField(el) || !el.value) continue;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    cleared++;
  }
  return JSON.stringify({ href: location.href, cleared });
})`;

const UNMARK = `((nonce) => {
  ${PAGE_HELPERS}
  for (const el of marked(nonce + ":")) el.removeAttribute(MARK);
  try { delete window["__ombLogin" + nonce]; } catch {}
  return JSON.stringify({ href: location.href });
})`;

function call(script: string, ...args: unknown[]): string {
  return `${script}(${args.map((arg) => JSON.stringify(arg ?? null)).join(", ")})`;
}

/** agent-browser hands back the expression's result, which these scripts make a JSON string. */
function evaluated(data: Record<string, unknown> | null): Record<string, unknown> | null {
  let value: unknown = data?.result;
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function listed(logins: Array<LoginPlace & { username: string }>): string {
  if (!logins.length) return "You have no saved logins.";
  const shown = logins.slice(0, 12).map(loginLabel);
  return `Your saved logins: ${shown.join(", ")}${logins.length > shown.length ? ` and ${logins.length - shown.length} more` : ""}.`;
}

function joinWords(words: string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** Without its query or fragment, where sign-in pages carry codes and tokens. */
function pageAddress(href: string): string {
  try { const url = new URL(href); return `${url.origin}${url.pathname}`; } catch { return "the next page"; }
}

function sameDocumentUrl(a: string, b: string): boolean {
  return a.split("#", 1)[0] === b.split("#", 1)[0];
}

const FIELD_WORDS: Record<FilledField, string> = { username: "the username", password: "the password", code: "the one-time code" };
const CODE_FROM_INBOX = "If the site sent it to the person's own email or phone, read it from their connected email or messages and type it in yourself; otherwise call request_sign_in so the person enters it.";

interface PageState { href: string; title: string; present: boolean; busy: boolean; submitted: boolean; leaving: boolean; alert: string; human: boolean }

function pageState(value: Record<string, unknown> | null): PageState | null {
  if (!value || typeof value.href !== "string") return null;
  return {
    href: value.href, title: typeof value.title === "string" ? value.title : "", present: value.present === true, busy: value.busy === true,
    submitted: value.submitted === true, leaving: value.leaving === true,
    alert: typeof value.alert === "string" ? value.alert : "", human: value.human === true,
  };
}

export async function fillLogin(input: FillLoginInput, deps: FillLoginDeps): Promise<FillLoginOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const page = await deps.engine(["get", "url"]);
  const pageUrl = typeof page?.url === "string" ? page.url : "";
  if (!page || !pageUrl || pageUrl === "about:blank") {
    return { ok: false, text: "The browser has no page open. Open the site's login page first, then call fill_login." };
  }
  // The page must be one a login may ever be filled on before any login is looked at.
  const fillable = loginPageCheck(pageUrl);
  if (!fillable.ok) {
    return { ok: false, host: fillable.pageHost ?? undefined, text: fillable.reason === "insecure"
      ? `This page (${fillable.pageHost}) is not secure (http, not https). fill_login only fills https pages, or http on this computer.`
      : "The current page is not a web page fill_login can fill. Open the site's login page, then call fill_login." };
  }
  const pageHost = fillable.pageHost;
  const all = await input.candidates(pageHost);
  if (!all.length) {
    const trouble = input.trouble?.();
    const missing = trouble ? ` 1Password could not be read just now, so its logins may be missing: ${trouble}` : "";
    return { ok: false, host: pageHost, text: `No saved login for ${pageHost}. A login fills on its own site and the sign-in hosts saved with it, never on another site. ${listed(await input.available())}${missing} Open that site's login page, or call request_sign_in so the person signs in.` };
  }
  let chosen = all;
  const wanted = input.username?.trim();
  if (wanted) {
    chosen = all.filter((login) => login.username.toLowerCase() === wanted.toLowerCase());
    if (!chosen.length) {
      return { ok: false, host: pageHost, text: `No saved login for ${pageHost} has the username ${JSON.stringify(wanted)}. The usernames saved there: ${all.map((login) => login.username).join(", ")}.` };
    }
  }
  if (chosen.length > 1) {
    return { ok: false, host: pageHost, text: `There are ${chosen.length} saved logins for ${pageHost}: ${chosen.map((login) => login.username).join(", ")}. Call fill_login again with the username to use.` };
  }
  const login = chosen[0]!;
  if (!loginOriginCheck(pageUrl, login).ok) {
    return { ok: false, host: pageHost, text: `This page's host (${pageHost}) is not one the saved login for ${loginLabel(login)} fills on.` };
  }
  return new LoginRun(login, { submit: input.submit !== false, host: pageHost, deps, now, sleep }).run();
}

interface Found {
  href: string;
  username: boolean;
  password: boolean;
  code: number;
  human: boolean;
  alert: string;
}

function found(value: Record<string, unknown> | null): Found | null {
  if (!value || typeof value.href !== "string") return null;
  return {
    href: value.href, username: value.username === true, password: value.password === true,
    code: typeof value.code === "number" ? Math.min(Math.max(0, value.code), 12) : 0,
    human: value.human === true, alert: typeof value.alert === "string" ? value.alert : "",
  };
}

type Submitted = { kind: "no-control" } | { kind: "done"; changed: boolean; href: string; title: string; alert: string; human: boolean };

/** One fill_login call on one login: each step fills what the page shows and submits it, then reads what the page did. */
class LoginRun {
  private readonly nonce = randomBytes(12).toString("hex");
  private readonly login: FillCandidate;
  private readonly submit: boolean;
  private readonly deps: FillLoginDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly host: string;
  private readonly deadline: number;
  private readonly done = new Set<FilledField>();
  private secrets: { password: string; totp: TotpKey | null } | null = null;
  private secretUrl: string | null = null;

  constructor(login: FillCandidate, options: { submit: boolean; host: string; deps: FillLoginDeps; now: () => number; sleep: (ms: number) => Promise<void> }) {
    this.login = login;
    this.submit = options.submit;
    this.host = options.host;
    this.deps = options.deps;
    this.now = options.now;
    this.sleep = options.sleep;
    this.deadline = this.now() + FILL_BUDGET_MS;
  }

  private stillHere(href: string): boolean {
    return loginOriginCheck(href, this.login).ok;
  }

  private async page(script: string, ...args: unknown[]): Promise<Record<string, unknown> | null> {
    try { return evaluated(await this.deps.engine(["eval", call(script, ...args)])); } catch { return null; }
  }

  private who(): string {
    return `${this.login.username || "the saved login"}${this.login.source === "1password" ? " (from 1Password)" : ""}`;
  }

  private filledWords(): string {
    return joinWords([...this.done].map((field) => FIELD_WORDS[field]));
  }

  private outcome(ok: boolean, text: string, held?: SecretHold): FillLoginOutcome {
    const hold = held ?? (this.secretUrl ? { url: this.secretUrl, ms: SECRET_HOLD_MS } : undefined);
    return { ok, host: this.host, loginId: this.login.id, filled: [...this.done], ...(hold ? { held: hold } : {}), text: scrubHeldSecrets(text) };
  }

  /** Every password and code this run filled, on whatever document still has them. */
  private async clear(): Promise<void> {
    await this.page(CLEAR_SECRETS, this.nonce);
    await this.page(UNMARK, this.nonce);
  }

  private async finish(ok: boolean, text: string): Promise<FillLoginOutcome> {
    await this.page(UNMARK, this.nonce);
    return this.outcome(ok, text);
  }

  private async failed(text: string): Promise<FillLoginOutcome> {
    await this.clear();
    return this.outcome(false, `${text} The password was cleared from the page.`);
  }

  /** The fields a page shows; for a later step, waits up to `waitMs` for a password or code box. */
  private async find(step: number, waitMs: number): Promise<Found | null> {
    const until = Math.min(this.deadline, this.now() + waitMs);
    for (;;) {
      const fields = found(await this.page(FIND_FIELDS, this.nonce, step));
      const ready = fields && (fields.password || fields.code > 0 || fields.human || !this.stillHere(fields.href));
      if (ready || this.now() >= until) return fields;
      await this.sleep(POLL_MS);
    }
  }

  async run(): Promise<FillLoginOutcome> {
    try {
      return await this.steps();
    } catch (error) {
      await this.clear();
      throw error;
    }
  }

  private async steps(): Promise<FillLoginOutcome> {
    let fields = await this.find(0, 0);
    for (let step = 0; ; step++) {
      if (!fields) {
        return step === 0
          ? this.outcome(false, "The browser closed or did not answer. Open the login page again, then call fill_login.")
          : this.finish(true, `Submitted ${this.filledWords()} for ${this.who()}; the page has not answered since. Check you are signed in.`);
      }
      if (!this.stillHere(fields.href)) {
        if (step === 0) return this.outcome(false, `The page moved away from ${this.host} before anything was filled. Open its login page again, then call fill_login.`);
        return this.finish(true, `Submitted ${this.filledWords()} for ${this.who()}; the page is now ${pageAddress(fields.href)}, where this login is not used. Check you are signed in, or call request_sign_in.`);
      }
      if ((fields.password && this.done.has("password")) || (fields.code > 0 && this.done.has("code"))) {
        const said = fields.alert ? ` It said: “${fields.alert}”.` : "";
        return this.failed(`The site did not accept the login for ${this.who()} on ${this.host}: it asked for it again, and nothing was submitted twice.${said} Check the saved login in Settings → Logins, or call request_sign_in.`);
      }
      if (step > 0 && !fields.password && fields.code === 0) {
        if (fields.human) return this.finish(true, `Submitted ${this.filledWords()} for ${this.who()}, and a human check (CAPTCHA) appeared. Call request_sign_in so the person finishes signing in.`);
        if (!this.done.has("password")) return this.finish(true, `Submitted ${this.filledWords()} for ${this.who()}, but no password box followed on ${this.host}. Look at the page, then call fill_login again once it shows the password box.`);
        return this.finish(true, this.signedIn(fields.href, ""));
      }
      const typed = await this.fillStep(step, fields);
      if (typed.kind === "moved") {
        await this.page(UNMARK, this.nonce);
        return this.outcome(false, `The page moved away from ${this.host} before anything was filled. Open its login page again, then call fill_login.`);
      }
      if (typed.kind === "none") {
        await this.page(UNMARK, this.nonce);
        if (fields.code > 0 && !this.secretsHaveTotp()) {
          return step > 0
            ? this.outcome(true, `Submitted ${this.filledWords()} for ${this.who()}. The page now asks for a one-time code, and the saved login has no 2FA key. ${CODE_FROM_INBOX}`)
            : this.outcome(false, `This page on ${this.host} asks for a one-time code, and the saved login has no 2FA key. ${CODE_FROM_INBOX}`);
        }
        return !fields.username && !fields.password && fields.code === 0
          ? this.outcome(false, `No login fields found on ${this.host}. Open its sign-in page (the one with the username, password or code box), then call fill_login again.`)
          : this.outcome(false, `Could not fill the login fields on ${this.host}: the page did not take the typing. Click the field once, then call fill_login again, or call request_sign_in.`);
      }
      const codeMissing = fields.code > 0 && !this.secretsHaveTotp();
      const codeNote = codeMissing ? ` The page also asks for a one-time code, and the saved login has no 2FA key: if it still needs one after the form is sent, ${CODE_FROM_INBOX[0]!.toLowerCase()}${CODE_FROM_INBOX.slice(1)}` : "";
      if (!this.submit) return this.leave(`Submit the form now (its sign-in button, or Enter).${codeNote}`);
      if (fields.human) return this.leave(`It was not submitted: the page shows a human check (CAPTCHA). Call request_sign_in so the person completes it and presses the sign-in button.${codeNote}`);
      let sent: Submitted;
      try {
        sent = await this.submitStep(step, typed.last, fields.alert);
      } catch {
        return this.failed(`Filled ${this.filledWords()} for ${this.who()} on ${this.host}, but the browser did not take the Enter key or the click to submit it.`);
      }
      if (sent.kind === "no-control") return this.leave(`It was not submitted: Enter did nothing and the page has no sign-in button to press. Press the page's own sign-in button now.${codeNote}`);
      if (sent.human) return this.failed(`A human check (CAPTCHA) appeared on ${this.host} after the login for ${this.who()} was submitted. Call request_sign_in so the person finishes signing in.`);
      if (!sent.changed) {
        const said = sent.alert ? ` It said: “${sent.alert}”.` : " The page did not change.";
        return this.failed(`The site did not accept the login for ${this.who()} on ${this.host}.${said} Check the saved login in Settings → Logins, or call request_sign_in.`);
      }
      if (step + 1 >= MAX_STEPS) return this.finish(true, this.signedIn(sent.href, sent.title));
      const waitMs = !this.done.has("password") ? NEXT_STEP_WAIT_MS : this.secretsHaveTotp() && !this.done.has("code") ? 5_000 : 1_500;
      fields = await this.find(step + 1, waitMs);
      if (fields && this.stillHere(fields.href) && !fields.password && fields.code === 0 && !fields.human && this.done.has("password")) {
        return this.finish(true, this.signedIn(sent.href, sent.title));
      }
    }
  }

  private secretsHaveTotp(): boolean {
    return Boolean(this.secrets?.totp);
  }

  private signedIn(href: string, title: string): string {
    const named = title ? ` (“${title.slice(0, 120)}”)` : "";
    return `Filled ${this.filledWords()} for ${this.who()} on ${this.host} and submitted it; the page is now ${pageAddress(href)}${named}. Check you are signed in.`;
  }

  /** The filled values stay for the bot or the person to submit, and are cleared if they are still there when the hold ends. */
  private leave(next: string): FillLoginOutcome {
    const held = this.secretUrl ? { url: this.secretUrl, ms: SECRET_HOLD_MS, clear: () => this.clear() } : undefined;
    const kept = held ? ` The password is cleared from the page in ${SECRET_HOLD_MS / 1000} seconds.` : "";
    return this.outcome(true, `Filled ${this.filledWords()} for ${this.who()} on ${this.host}. ${next}${kept} You never see the password; do not read it back from the page.`, held);
  }

  private async type(key: string, text: string, keep?: string): Promise<"typed" | "kept" | "missed" | "moved"> {
    const focus = await this.page(FOCUS_FIELD, this.nonce, key, "type", keep ?? null);
    if (!focus || typeof focus.href !== "string" || !this.stillHere(focus.href)) return "moved";
    if (focus.same === true) return "kept";
    if (focus.focused !== true) return "missed";
    await this.deps.insertText(text);
    return "typed";
  }

  private async fillStep(step: number, fields: Found): Promise<{ kind: "typed"; last: string } | { kind: "none" } | { kind: "moved" }> {
    const key = `${this.nonce}:${step}:`;
    const typed: Array<[FilledField, string]> = [];
    let moved = false;
    const fill = async (name: string, text: string, keep?: string) => {
      if (moved) return false;
      const result = await this.type(key + name, text, keep);
      if (result === "moved") moved = true;
      return result === "typed" || result === "kept";
    };
    if (fields.username && this.login.username && await fill("username", this.login.username, this.login.username)) typed.push(["username", "username"]);
    if (!moved && (fields.password || fields.code > 0)) {
      this.secrets ??= await this.login.secrets();
      this.deps.remember(this.secrets.password, "password");
      if (this.secrets.totp) this.deps.remember(this.secrets.totp.secret, "password");
    }
    if (!moved && fields.password && this.secrets && await fill("password", this.secrets.password)) typed.push(["password", "password"]);
    if (!moved && fields.code > 0 && this.secrets?.totp) {
      const totp = this.secrets.totp;
      const left = totp.period * 1000 - (this.now() % (totp.period * 1000));
      if (left < 3_000) await this.sleep(left + 250);
      const code = totpCode(totp, this.now());
      this.deps.remember(code, "code");
      const boxes = fields.code === 1 ? 1 : Math.min(fields.code, code.length);
      let last = "";
      for (let index = 0; index < boxes && !moved; index++) if (await fill(`code${index}`, boxes === 1 ? code : code[index]!)) last = `code${index}`;
      if (last) typed.push(["code", last]);
    }
    const checked = await this.page(CHECK_FIELDS, key);
    const held = checked ? typed.filter(([field]) => checked[field === "code" ? "code0" : field] === true) : [];
    if (moved && !held.length) return { kind: "moved" };
    if (!held.length) return { kind: "none" };
    for (const [field] of held) this.done.add(field);
    if (held.some(([field]) => field !== "username")) this.secretUrl = fields.href;
    return { kind: "typed", last: held.at(-1)![1] };
  }

  /** Enter in the step's last field; when that sends nothing within two seconds, the form's sign-in button. */
  private async submitStep(step: number, last: string, alertBefore: string): Promise<Submitted> {
    const key = `${this.nonce}:${step}:`;
    const focus = await this.page(FOCUS_FIELD, this.nonce, key + last, "submit", null);
    const before = typeof focus?.href === "string" ? focus.href : "";
    const busyBefore = focus?.busy === true;
    const sending = (state: PageState) => state.submitted || (state.busy && !busyBefore);
    const fresh = (alert: string) => Boolean(alert) && alert !== alertBefore;
    const moved = (state: PageState) => !sameDocumentUrl(state.href, before) || !state.present || state.leaving;
    const settled = (state: PageState | "silent") => state === "silent" || moved(state) || state.human || fresh(state.alert);
    // A page that stops answering is loading its next document.
    const watch = async (ms: number, untilSent: boolean): Promise<PageState | "silent"> => {
      const until = Math.min(this.deadline, this.now() + ms);
      for (;;) {
        await this.sleep(POLL_MS);
        const state = pageState(await this.page(PAGE_STATE, this.nonce));
        if (state && (settled(state) || (untilSent && sending(state)))) return state;
        if (this.now() >= until) return state ?? "silent";
      }
    };
    await this.deps.press("Enter");
    let state = await watch(ENTER_WAIT_MS, true);
    if (!settled(state) && !(state !== "silent" && sending(state))) {
      const control = await this.page(MARK_SUBMIT, key);
      if (control?.found !== true) return { kind: "no-control" };
      await this.deps.click(`[${MARK}="${key}submit"]`);
    }
    if (!settled(state)) state = await watch(OUTCOME_WAIT_MS, false);
    if (state === "silent") return { kind: "done", changed: true, href: before, title: "", alert: "", human: false };
    return { kind: "done", changed: moved(state), href: state.href, title: state.title, alert: fresh(state.alert) ? state.alert : "", human: !moved(state) && state.human };
  }
}
