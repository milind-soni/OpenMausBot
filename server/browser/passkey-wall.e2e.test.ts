// A sign-in that stops at a passkey, on real Chrome: fixture pages shaped like Google's sign-in, whose passkey and
// security-key steps ask WebAuthn for a credential as Google's do. The bot's answers go through the runtime router, as
// on a server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BrowserRuntime } from "../browser-runtime.ts";
import { hostTimeout } from "../testing/host-timeout.ts";
import { FixtureServer } from "./cdp/testing/fixtures.ts";
import { CHROME } from "./cdp/testing/real-chrome.ts";
import { CHROME_ENGINE, RuntimeRouter, type ChromeEngine } from "./engines.ts";
import { passkeyAnnotation, passkeyNotice } from "./passkey-notice.ts";
import { startService, until, type RealService, type ToolResult } from "./testing/real-service.ts";

const suite = CHROME ? describe : describe.skip;

const GOOGLE = `<div role="img" aria-label="Google">Google</div>`;
const SIGN_IN = (body: string) => `<!doctype html><meta charset="utf-8"><title>Sign in - Google Accounts</title>${GOOGLE}${body}`;
/** The request a WebAuthn step makes, and what the page shows once it ends. WebAuthn needs a registrable RP ID, so these
 * pages are served from localhost, not 127.0.0.1. */
const ASKS = (request: string) => `<p id="state">Waiting…</p><script>
  const state = document.getElementById("state");
  const started = performance.now();
  ${request}
    .then(() => { state.textContent = "Signed in"; }, (error) => { state.textContent = "Something went wrong: " + error.name; state.dataset.after = String(performance.now() - started); });
</script>`;
const PASSKEY = `navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: "localhost", allowCredentials: [], userVerification: "required", timeout: 300000 } })`;
const SECURITY_KEY = `navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: "localhost", allowCredentials: [{ type: "public-key", id: new Uint8Array(64).fill(7) }], userVerification: "discouraged", timeout: 300000 } })`;
const CREATE = `navigator.credentials.create({ publicKey: { challenge: new Uint8Array(32), rp: { id: "localhost", name: "Google" }, user: { id: new Uint8Array(16).fill(1), name: "person@example.test", displayName: "Person" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" }, timeout: 300000 } })`;
const OTHER_WAY = `<a href="/v3/signin/challenge/selection">Try another way</a>`;

suite("a passkey step in the bots' browser on real Chrome", () => {
  let fx: FixtureServer;
  let real: RealService;
  let router: RuntimeRouter;
  let bots = 0;
  const said = (result: unknown) => real.text(result as ToolResult);

  beforeAll(async () => {
    fx = await FixtureServer.start();
    fx.page("/v3/signin/identifier", SIGN_IN(`<h1>Sign in</h1><label>Email or phone <input id="email"></label><button onclick="location.href='/v3/signin/challenge/pk/presend'">Next</button><a href="#">Sign in with a passkey</a>`));
    fx.page("/v3/signin/challenge/pk/presend", SIGN_IN(`<h1>Verifying it’s you</h1><p>Complete sign-in using your passkey</p>${OTHER_WAY}${ASKS(PASSKEY)}`));
    fx.page("/v3/signin/challenge/sk/webauthn", SIGN_IN(`<h1>2-Step Verification</h1><p>Use your security key</p>${OTHER_WAY}${ASKS(SECURITY_KEY)}`));
    fx.page("/v3/signin/challenge/selection", SIGN_IN(`<h1>Choose how you want to sign in</h1><a href="/v3/signin/challenge/pwd">Enter your password</a><a href="/v3/signin/challenge/ipp/collect">Get a verification code at ••• 42</a>`));
    fx.page("/v3/signin/challenge/pwd", SIGN_IN(`<h1>Welcome</h1><label>Enter your password <input type="password"></label><button>Next</button>`));
    fx.page("/v3/signin/challenge/ipp/collect", SIGN_IN(`<h1>2-Step Verification</h1><p>A text message with a 6-digit verification code was just sent to ••• 42</p><label>Enter code <input id="code"></label><button onclick="if (/^\\d{6}$/.test(document.getElementById('code').value)) location.href = '/signed-in'">Next</button>`));
    fx.page("/signed-in", `<!doctype html><meta charset="utf-8"><title>Google Account</title><h1>Welcome, Person</h1>`);
    fx.page("/passkey-enrollment", SIGN_IN(`<h1>Sign in faster with a passkey</h1><button>Not now</button>${ASKS(CREATE)}`));
    real = await startService();
    const agentBrowser = { agentRpc: () => Promise.reject(new Error("agent-browser is not part of this suite")) } as unknown as BrowserRuntime;
    router = new RuntimeRouter(agentBrowser, { service: real.service } as unknown as ChromeEngine, { annotate: passkeyAnnotation("cloud") });
  }, hostTimeout(240_000));

  afterAll(async () => {
    await real?.close();
    await fx?.close();
  });

  const browser = () => {
    const key = `bot:passkey-${++bots}`;
    const session = `passkey-${bots}`;
    const spec = { command: CHROME_ENGINE, args: [key], env: {} };
    return {
      call: (name: string, args: Record<string, unknown> = {}) => router.agentRpc(session, spec, "tools/call", { name, arguments: args }),
      read: <T = string>(expression: string) => real.read<T>({ session, key }, expression),
    };
  };
  const at = (path: string) => fx.crossSiteUrl(path);
  const ended = (bot: ReturnType<typeof browser>) => until(() => bot.read("document.querySelector('#state').textContent"), (state) => state !== "Waiting…", 5_000);

  it("ends a passkey request at once, as a dismissed passkey sheet does, and tells the bot what works", async () => {
    const bot = browser();
    const opened = said(await bot.call("agent_browser_open", { url: at("/v3/signin/challenge/pk/presend") }));
    expect(opened).toContain("Complete sign-in using your passkey");
    expect(opened.endsWith(passkeyNotice("google", "cloud"))).toBe(true);
    expect(await ended(bot)).toBe("Something went wrong: NotAllowedError");
    expect(Number(await bot.read("document.querySelector('#state').dataset.after"))).toBeLessThan(2_000);
    expect(said(await bot.call("agent_browser_snapshot")).endsWith(passkeyNotice("google", "cloud"))).toBe(true);
  }, hostTimeout(60_000));

  it("ends a security key request the same way, and Try another way works there", async () => {
    const bot = browser();
    expect(said(await bot.call("agent_browser_open", { url: at("/v3/signin/challenge/sk/webauthn") }))).toContain("Use your security key");
    expect(await ended(bot)).toBe("Something went wrong: NotAllowedError");
    expect(said(await bot.call("agent_browser_click", { selector: "text=Try another way" }))).toContain("/v3/signin/challenge/selection");
  }, hostTimeout(60_000));

  it("from the email step: the passkey step carries the notice, then Try another way, the options and a code", async () => {
    const bot = browser();
    const identifier = said(await bot.call("agent_browser_open", { url: at("/v3/signin/identifier") }));
    expect(identifier).toContain("Sign in with a passkey");
    expect(identifier).not.toContain(passkeyNotice("google", "cloud"));
    await bot.call("agent_browser_fill", { selector: "#email", text: "person@example.test" });
    await bot.call("agent_browser_click", { selector: "button" });
    expect(said(await bot.call("agent_browser_snapshot"))).toContain(passkeyNotice("google", "cloud"));
    expect(await ended(bot)).toBe("Something went wrong: NotAllowedError");
    const another = said(await bot.call("agent_browser_click", { selector: "text=Try another way" }));
    expect(another).toContain("/v3/signin/challenge/selection");
    expect(another).not.toContain(passkeyNotice("google", "cloud"));
    const choices = said(await bot.call("agent_browser_snapshot"));
    expect(choices).toContain("Enter your password");
    expect(choices).not.toContain(passkeyNotice("google", "cloud"));
    expect(said(await bot.call("agent_browser_click", { selector: "text=Get a verification code" }))).toContain("/v3/signin/challenge/ipp/collect");
    await bot.call("agent_browser_fill", { selector: "#code", text: "123456" });
    const done = said(await bot.call("agent_browser_click", { selector: "button" }));
    expect(done).toContain("/signed-in");
    expect(said(await bot.call("agent_browser_snapshot"))).toContain("Welcome, Person");
  }, hostTimeout(60_000));

  it("lets no site register a passkey in this browser, which would forget it", async () => {
    const bot = browser();
    await bot.call("agent_browser_open", { url: at("/passkey-enrollment") });
    expect(await ended(bot)).toBe("Something went wrong: NotAllowedError");
  }, hostTimeout(60_000));
});
