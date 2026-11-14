import { afterEach, describe, expect, it } from "vitest";

import { loginMatchesHost, loginPlace, type LoginPlace } from "../shared/logins.ts";
import { fillLogin, SECRET_HOLD_MS, type FillCandidate, type FillLoginDeps } from "./login-fill.ts";
import { FakeLoginPage, LOGIN_FORM } from "./testing/fake-login-page.ts";
import { parseTotpKey, totpCode, type TotpKey } from "./totp.ts";

// Obvious fakes only.
const PASSWORD = "fake-S3cret!pass";
const KEY = parseTotpKey("JBSWY3DPEHPK3PXP")!;
const NOW = 1_700_000_010_000; // 10 s into a 30 s step
const DASHBOARD = { url: "https://example.com/dashboard?session=abc", html: "<title>Dashboard</title><h1>Welcome back</h1>" };

let page: FakeLoginPage | null = null;
afterEach(() => { page?.close(); page = null; });

type Login = Partial<LoginPlace> & { id?: string; host?: string; username: string; password?: string; totp?: TotpKey | null };
function setup(url: string, html: string, saved: Login[], options: { submit?: boolean } = {}) {
  page = new FakeLoginPage(url, html);
  const remembered: Array<[string, string]> = [];
  const logins = saved.map((login, index): FillCandidate => ({
    ...loginPlace(login.host ?? login.site!, login.hosts ?? [], login.exactHost ?? false),
    ...(login.site ? { site: login.site } : {}),
    id: login.id ?? `login-${index}`, username: login.username, source: "settings",
    secrets: async () => ({ password: login.password ?? PASSWORD, totp: login.totp ?? null }),
  }));
  let clock = NOW;
  const deps: FillLoginDeps = {
    engine: (args) => page!.engine(args),
    insertText: (text) => page!.insertText(text),
    press: (key) => page!.press(key),
    click: (selector) => page!.click(selector),
    remember: (value, kind) => { remembered.push([kind, value]); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  const fill = (username?: string) => fillLogin({
    username, submit: options.submit,
    candidates: async (host) => logins.filter((login) => loginMatchesHost(login, host)),
    available: async () => logins.map(({ site, hosts, exactHost, username: name }) => ({ site, hosts, exactHost, username: name })),
  }, deps);
  return { page, fill, remembered };
}

function expectNoSecret(outcome: unknown, current: FakeLoginPage, secrets: string[]) {
  const said = JSON.stringify(outcome);
  const commands = JSON.stringify(current.engineCalls);
  for (const secret of secrets) {
    expect(said).not.toContain(secret);
    expect(commands).not.toContain(secret);
  }
}

describe("fill_login fills and submits in one call", () => {
  it("types the username and password as real input, presses Enter, and says where the page went, never a value", async () => {
    const { page, fill, remembered } = setup("https://accounts.example.com/login", LOGIN_FORM, [{ site: "example.com", hosts: ["example.com"], username: "alice@example.com" }]);
    page.answer = () => ({ navigate: DASHBOARD });
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, host: "accounts.example.com", filled: ["username", "password"] });
    expect(outcome.text).toBe("Filled the username and the password for alice@example.com on accounts.example.com and submitted it; the page is now https://example.com/dashboard (“Dashboard”). Check you are signed in.");
    expect(page.typed).toEqual(["alice@example.com", PASSWORD]);
    expect(page.pressed).toEqual(["Enter"]);
    expect(page.sent).toEqual([{ email: "alice@example.com", password: PASSWORD, csrf: "token-not-a-secret" }]);
    expect(page.clicked).toEqual([]);
    expect(remembered).toContainEqual(["password", PASSWORD]);
    expect(outcome.held).toEqual({ url: "https://accounts.example.com/login", ms: SECRET_HOLD_MS });
    expectNoSecret(outcome, page, [PASSWORD]);
  });

  it("presses the form's sign-in button when Enter sends nothing", async () => {
    const { page, fill } = setup("https://example.com/login",
      `<div><input name="email" type="email" autocomplete="username"><input name="password" type="password"><button type="button" id="go">Log in</button></div>`,
      [{ host: "example.com", username: "alice" }]);
    page.window.document.querySelector("#go")!.addEventListener("click", () => page.navigate(DASHBOARD.url, DASHBOARD.html));
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["username", "password"] });
    expect(page.pressed).toEqual(["Enter"]);
    expect(page.clicked).toHaveLength(1);
    expect(page.clicked[0]).toMatch(/^\[data-omb-login="[0-9a-f]{24}:0:submit"\]$/u);
    expect(outcome.text).toContain("the page is now https://example.com/dashboard");
  });

  it("waits for a page that sends the login by its own script, instead of pressing its button as well", async () => {
    const { page, fill } = setup("https://example.com/login",
      `<div><input name="email" type="email" autocomplete="username"><input name="password" type="password"><button type="button" id="go">Log in</button></div>`,
      [{ host: "example.com", username: "alice@example.com" }]);
    let polls = 0;
    page.onKey = (key) => { if (key === "Enter") page.window.document.body.setAttribute("aria-busy", "true"); };
    const engine = page.engine.bind(page);
    page.engine = async (args) => {
      if (args[0] === "eval" && args[1]!.includes("present:") && page.window.document.body.getAttribute("aria-busy") === "true" && ++polls === 12) page.navigate(DASHBOARD.url, DASHBOARD.html);
      return engine(args);
    };
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["username", "password"] });
    expect(page.clicked).toEqual([]);
    expect(polls).toBe(12);
    expect(outcome.text).toContain("the page is now https://example.com/dashboard");
  });

  it("goes through a two-step login in one call: the username, Next, then the password", async () => {
    const { page, fill } = setup("https://login.example.com/", `<form><input name="identifier" type="email" autocomplete="username"><button>Next</button></form>`,
      [{ host: "login.example.com", username: "alice@example.com" }]);
    page.answer = (fields) => fields.identifier
      ? { navigate: { url: "https://login.example.com/challenge", html: `<form><input name="Passwd" type="password"><button>Next</button></form>` } }
      : { navigate: DASHBOARD };
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["username", "password"] });
    expect(page.sent).toEqual([{ identifier: "alice@example.com" }, { Passwd: PASSWORD }]);
    expect(page.pressed).toEqual(["Enter", "Enter"]);
    expect(page.window.location.href).toBe(DASHBOARD.url);
    expect(outcome.text).toContain("and submitted it; the page is now https://example.com/dashboard");
  });

  it("fills the one-time code made at fill time from the saved 2FA key on the step after the password", async () => {
    const { page, fill, remembered } = setup("https://example.com/login", LOGIN_FORM, [{ host: "example.com", username: "alice@example.com", totp: KEY }]);
    let code = "";
    page.answer = (fields) => {
      if (fields.password) return { navigate: { url: "https://example.com/2fa", html: `<form><input name="otp" autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form>` } };
      code = fields.otp ?? "";
      return { navigate: DASHBOARD };
    };
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["username", "password", "code"] });
    expect(page.sent).toHaveLength(2);
    expect(code).toMatch(/^\d{6}$/u);
    expect(remembered).toContainEqual(["code", code]);
    expectNoSecret(outcome, page, [PASSWORD, code, KEY.secret]);
  });
});

describe("a login fills on its own site, and nowhere else", () => {
  it.each([
    ["a subdomain", "https://accounts.example.com/login"],
    ["www", "https://www.example.com/login"],
    ["the site itself", "https://example.com/login"],
    ["a trailing-dot host", "https://login.example.com./"],
  ])("fills a login for example.com on %s", async (_name, url) => {
    const { page, fill } = setup(url, LOGIN_FORM, [{ host: "example.com", username: "alice" }], { submit: false });
    expect(await fill()).toMatchObject({ ok: true, filled: ["username", "password"] });
    expect(page.field("#password").value).toBe(PASSWORD);
  });

  it.each([
    ["a look-alike host", "https://example.com.evil.test/login"],
    ["a host that only ends the same", "https://myexample.com/login"],
    ["another public suffix", "https://example.co.uk/login"],
  ])("refuses %s", async (_name, url) => {
    const { page, fill } = setup(url, LOGIN_FORM, [{ host: "example.com", username: "alice" }]);
    const outcome = await fill();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain(`No saved login for ${new URL(url).hostname}.`);
    expect(outcome.text).toContain("Your saved logins: example.com (alice).");
    expect(page.typed).toEqual([]);
    expect(page.engineCalls).toEqual([["get", "url"]]);
  });

  it("never offers alice.github.io's login on bob.github.io: a name under a shared suffix is a site of its own", async () => {
    const { page, fill } = setup("https://bob.github.io/login", LOGIN_FORM, [{ host: "alice.github.io", username: "alice" }]);
    const outcome = await fill();
    expect(outcome.text).toContain("No saved login for bob.github.io.");
    expect(outcome.text).toContain("Your saved logins: alice.github.io (alice).");
    expect(page.engineCalls).toEqual([["get", "url"]]);
  });

  it("fills on a sign-in host on another site saved with the login, such as Microsoft's", async () => {
    const { page, fill } = setup("https://login.microsoftonline.com/common/login", LOGIN_FORM,
      [{ host: "example.com", hosts: ["example.com", "login.microsoftonline.com"], username: "alice@example.com" }], { submit: false });
    expect(await fill()).toMatchObject({ ok: true, host: "login.microsoftonline.com", filled: ["username", "password"] });
    expect(page.field("#password").value).toBe(PASSWORD);
    page.navigate("https://login.live.com/login", LOGIN_FORM);
    expect((await fill()).text).toContain("No saved login for login.live.com.");
  });

  it("keeps a login marked for its exact host to that host", async () => {
    const saved = [{ host: "acme.okta.com", username: "alice@example.com", exactHost: true }];
    const { page, fill } = setup("https://evil.okta.com/login", LOGIN_FORM, saved);
    const refused = await fill();
    expect(refused.text).toContain("No saved login for evil.okta.com.");
    expect(refused.text).toContain("Your saved logins: acme.okta.com (alice@example.com).");
    page.navigate("https://acme.okta.com/login", LOGIN_FORM);
    page.answer = () => ({ navigate: { url: "https://acme.okta.com/app", html: "<title>Apps</title>" } });
    expect(await fill()).toMatchObject({ ok: true, filled: ["username", "password"] });
  });

  it("refuses the saved host over plain http, and allows plain http on this computer", async () => {
    const insecure = setup("http://example.com/login", LOGIN_FORM, [{ host: "example.com", username: "alice" }]);
    const outcome = await insecure.fill();
    expect(outcome.text).toContain("not secure (http, not https)");
    expect(insecure.page.typed).toEqual([]);
    insecure.page.close();
    const local = setup("http://localhost:3000/login", LOGIN_FORM, [{ host: "localhost", username: "dev" }], { submit: false });
    expect(await local.fill()).toMatchObject({ ok: true, filled: ["username", "password"] });
  });

  it("stops when the page leaves the site between finding the fields and typing", async () => {
    const { page, fill } = setup("https://example.com/login", LOGIN_FORM, [{ host: "example.com", username: "alice" }]);
    const engine = page.engine.bind(page);
    let evals = 0;
    page.engine = async (args) => {
      if (args[0] === "eval" && ++evals === 2) page.navigate("https://evil.test/login", LOGIN_FORM);
      return engine(args);
    };
    const outcome = await fill();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("moved away from example.com");
    expect(page.typed).toEqual([]);
  });

  it("says when no browser page is open", async () => {
    const { page, fill } = setup("about:blank", "", [{ host: "example.com", username: "alice" }]);
    expect((await fill()).text).toBe("The browser has no page open. Open the site's login page first, then call fill_login.");
    expect(page.typed).toEqual([]);
  });
});

describe("a login the site refuses is cleared from the page", () => {
  it("clears the password and repeats what the site said when it refuses the login on the same page", async () => {
    const { page, fill } = setup("https://example.com/login", LOGIN_FORM, [{ host: "example.com", username: "alice@example.com" }]);
    page.answer = () => ({ error: "Incorrect password." });
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: false, filled: ["username", "password"] });
    expect(outcome.text).toBe("The site did not accept the login for alice@example.com on example.com. It said: “Incorrect password.”. Check the saved login in Settings → Logins, or call request_sign_in. The password was cleared from the page.");
    expect(page.sent).toHaveLength(1);
    expect(page.field("#password").value).toBe("");
    expect(page.field("#email").value).toBe("alice@example.com");
    expect(page.window.document.querySelectorAll("[data-omb-login]")).toHaveLength(0);
  });

  it("never submits twice when the site answers with its login form again", async () => {
    const { page, fill } = setup("https://example.com/login", LOGIN_FORM, [{ host: "example.com", username: "alice@example.com" }]);
    page.answer = () => ({ navigate: { url: "https://example.com/login", html: `<div role="alert">Wrong email or password</div>${LOGIN_FORM}` } });
    const outcome = await fill();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("it asked for it again, and nothing was submitted twice. It said: “Wrong email or password”.");
    expect(page.sent).toHaveLength(1);
    expect(page.typed).toEqual(["alice@example.com", PASSWORD]);
  });

  it("clears the password when the page does not answer the submit at all", async () => {
    const { page, fill } = setup("https://example.com/login", LOGIN_FORM, [{ host: "example.com", username: "alice@example.com" }]);
    const outcome = await fill();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("The page did not change.");
    expect(page.sent).toHaveLength(1);
    expect(page.field("#password").value).toBe("");
  });
});

describe("what the page shows after the login is sent", () => {
  const CHECKBOX_CAPTCHA = `<iframe src="https://www.google.com/recaptcha/api2/anchor?k=fake"></iframe>`;

  it("leaves a form with a visible CAPTCHA for the person, filled but not sent", async () => {
    const { page, fill } = setup("https://example.com/login", `${CHECKBOX_CAPTCHA}${LOGIN_FORM}`, [{ host: "example.com", username: "alice" }]);
    page.frameSize = { width: 304, height: 78 };
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["username", "password"] });
    expect(outcome.text).toContain("It was not submitted: the page shows a human check (CAPTCHA). Call request_sign_in");
    expect(outcome.held?.clear).toBeTypeOf("function");
    expect(page.pressed).toEqual([]);
  });

  it("ignores an invisible CAPTCHA badge, and reports one that appears after the password went in", async () => {
    const { page, fill } = setup("https://example.com/login", `<iframe src="https://www.google.com/recaptcha/api2/anchor?k=fake&size=invisible"></iframe>${LOGIN_FORM}`,
      [{ host: "example.com", username: "alice@example.com" }]);
    page.frameSize = { width: 304, height: 78 };
    page.answer = () => ({ navigate: { url: "https://example.com/verify", html: `<title>Verify</title>${CHECKBOX_CAPTCHA}` } });
    const outcome = await fill();
    expect(page.sent).toHaveLength(1);
    expect(outcome).toMatchObject({ ok: true, filled: ["username", "password"] });
    expect(outcome.text).toBe("Submitted the username and the password for alice@example.com, and a human check (CAPTCHA) appeared. Call request_sign_in so the person finishes signing in.");
  });

  it("after the password, a code the saved login cannot make is the bot's to read from the person's inbox, or the person's to enter", async () => {
    const { page, fill } = setup("https://example.com/login", LOGIN_FORM, [{ host: "example.com", username: "alice@example.com" }]);
    page.answer = () => ({ navigate: { url: "https://example.com/2fa", html: `<form><input name="otp" autocomplete="one-time-code"><button>Verify</button></form>` } });
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["username", "password"] });
    expect(outcome.text).toBe("Submitted the username and the password for alice@example.com. The page now asks for a one-time code, and the saved login has no 2FA key. If the site sent it to the person's own email or phone, read it from their connected email or messages and type it in yourself; otherwise call request_sign_in so the person enters it.");
    expect(page.sent).toHaveLength(1);
  });
});

describe("filling without submitting", () => {
  it("leaves the form to the bot, and the clear it hands back empties the password once the hold ends", async () => {
    const { page, fill } = setup("https://example.com/login", LOGIN_FORM, [{ host: "example.com", username: "alice" }], { submit: false });
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["username", "password"], held: { url: "https://example.com/login", ms: SECRET_HOLD_MS } });
    expect(outcome.text).toBe("Filled the username and the password for alice on example.com. Submit the form now (its sign-in button, or Enter). The password is cleared from the page in 60 seconds. You never see the password; do not read it back from the page.");
    expect(page.sent).toEqual([]);
    expect(page.field("#password").value).toBe(PASSWORD);
    await outcome.held!.clear!();
    expect(page.field("#password").value).toBe("");
    expect(page.window.document.querySelectorAll("[data-omb-login]")).toHaveLength(0);
  });

  it("leaves it to the bot when Enter sends nothing and the page has no sign-in button", async () => {
    const { page, fill } = setup("https://example.com/login", `<input name="user" autocomplete="username"><input name="pass" type="password">`,
      [{ host: "example.com", username: "alice" }]);
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["username", "password"] });
    expect(outcome.text).toContain("It was not submitted: Enter did nothing and the page has no sign-in button to press.");
    expect(outcome.held?.clear).toBeTypeOf("function");
    expect(page.clicked).toEqual([]);
  });

  it("types over what a field already holds, and keeps a username that is already right", async () => {
    const { page, fill } = setup("https://accounts.example.com/login", LOGIN_FORM, [{ host: "accounts.example.com", username: "alice@example.com" }], { submit: false });
    page.field("#email").value = "alice@example.com";
    page.field("#password").value = "stale";
    expect(await fill()).toMatchObject({ ok: true, filled: ["username", "password"] });
    expect(page.typed).toEqual([PASSWORD]);
    expect(page.field("#password").value).toBe(PASSWORD);
    expect(page.state).toMatchObject({ password: PASSWORD });
  });
});

describe("one-time codes and fields", () => {
  it("fills six one-digit boxes one digit each", async () => {
    const boxes = Array.from({ length: 6 }, (_, index) => `<input name="d${index}" maxlength="1" inputmode="numeric" ${index === 0 ? 'autocomplete="one-time-code"' : ""}>`).join("");
    const { page, fill } = setup("https://example.com/2fa", `<form><div class="code">${boxes}</div></form>`, [{ host: "example.com", username: "alice", totp: KEY }], { submit: false });
    expect(await fill()).toMatchObject({ ok: true, filled: ["code"] });
    expect(Array.from({ length: 6 }, (_, index) => page.field(`input[name=d${index}]`).value).join("")).toBe(totpCode(KEY, NOW));
  });

  it("points at the person's inbox, then the person, when a code is asked for and no 2FA key is saved", async () => {
    const { page, fill } = setup("https://example.com/2fa", `<input name="verification_code">`, [{ host: "example.com", username: "alice" }]);
    const outcome = await fill();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("asks for a one-time code, and the saved login has no 2FA key. If the site sent it to the person's own email or phone, read it from their connected email or messages and type it in yourself; otherwise call request_sign_in");
    expect(outcome.held).toBeUndefined();
    expect(page.typed).toEqual([]);
  });

  it("never takes a sign-up form's new-password box for the login's password", async () => {
    const { page, fill } = setup("https://example.com/join", `<form><input name="email" type="email"><input name="new" type="password" autocomplete="new-password"></form>`,
      [{ host: "example.com", username: "alice@example.com" }], { submit: false });
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["username"] });
    expect(outcome.held).toBeUndefined();
    expect(page.field("input[name=new]").value).toBe("");
  });

  it("asks which login when a site has several, and fills the one named", async () => {
    const saved = [{ host: "example.com", username: "alice", password: "fake-alice-pw" }, { host: "example.com", username: "bob", password: "fake-bob-pw" }];
    const { page, fill } = setup("https://example.com/login", LOGIN_FORM, saved, { submit: false });
    const asked = await fill();
    expect(asked.ok).toBe(false);
    expect(asked.text).toBe("There are 2 saved logins for example.com: alice, bob. Call fill_login again with the username to use.");
    expect(await fill("Bob")).toMatchObject({ ok: true });
    expect(page.field("#password").value).toBe("fake-bob-pw");
    expect((await fill("carol")).text).toContain('has the username "carol"');
  });

  it("says when the page has no login fields", async () => {
    const { page, fill } = setup("https://example.com/", `<main><input type="search" name="q"><input type="hidden" name="x"></main>`, [{ host: "example.com", username: "alice" }]);
    const outcome = await fill();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("No login fields found on example.com.");
    expect(page.typed).toEqual([]);
  });

  it("ignores fields that are hidden from view", async () => {
    const { page, fill } = setup("https://example.com/login",
      `<form style="display:none"><input name="email" type="email"><input name="password" type="password"></form><form><input name="user" type="text" autocomplete="username"></form>`,
      [{ host: "example.com", username: "alice" }], { submit: false });
    expect(await fill()).toMatchObject({ ok: true, filled: ["username"] });
    expect(page.field("input[name=password]").value).toBe("");
  });
});
