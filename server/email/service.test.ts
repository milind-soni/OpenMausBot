import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EmailError, openGuard, sendingError } from "./client.ts";
import type { DiscoverDeps } from "./discover.ts";
import { createEmailService } from "./service.ts";
import { MAX_EMAIL_ACCOUNTS } from "./store.ts";

const PASSWORD = "fake-mailbox-password-1";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOWHERE: DiscoverDeps = { fetchText: async () => null, mx: async () => [], srv: async () => [], cname: async () => [], reverse: async () => [] };

type Login = { username: string; password: string } | null;
type Server = { host: string; port: number; secure: boolean };

/** `sending` answers both the check without a password (login null) and the sign-in; `sent` records only sign-ins. */
function service(mailbox: (imap: { host: string; port: number }, username: string, password: string) => { messages: number; newest?: { from: string; subject: string } } | EmailError, sending: (host: string, login: Login, server: Server) => Error | void = () => {}, more: { refusal?: string; dataDir?: string; discover?: Partial<DiscoverDeps>; send?: (account: unknown, input: unknown) => void } = {}) {
  const dataDir = more.dataDir ?? mkdtempSync(join(tmpdir(), "omb-mail-service-")); if (!more.dataDir) dirs.push(dataDir);
  const tried: string[] = [];
  const sent: string[] = [];
  const logins: string[] = [];
  const email = createEmailService({ dataDir, publicOnly: false, ...(more.refusal ? { refusal: more.refusal } : {}), discover: { ...NOWHERE, ...more.discover }, guard: openGuard, test: {
    mailbox: (async (account: { username: string; password: string; imap: { host: string; port: number } }) => { tried.push(`${account.imap.host}:${account.imap.port}:${account.username}`); const answer = mailbox(account.imap, account.username, account.password); if (answer instanceof EmailError) throw answer; return answer; }) as never,
    sending: (async (login: Login, server: Server) => {
      if (login) { sent.push(`${server.host}:${server.port}`); logins.push(`${server.host}:${login.username}:${login.password}`); }
      const answer = sending(server.host, login, server);
      if (answer) throw answer;
    }) as never,
    send: (async (account: unknown, _guard: unknown, input: unknown) => { more.send?.(account, input); return { messageId: "<1@x>", accepted: [], rejected: [], filed: false }; }) as never,
  } });
  return { email, tried, sent, logins, dataDir };
}
const NO_ANSWER = () => new EmailError("network", "no");
const WRONG = () => new EmailError("password", "no");
/** What Nodemailer says when nothing answers, and when a server refuses the password. */
const SILENT = () => Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
const REFUSED = () => Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 });

describe("connecting a mailbox", () => {
  it("keeps nothing until a real header has been read back, and then says what it read", async () => {
    const { email } = service((imap) => (imap.host === "imap.shop.example" ? { messages: 30, newest: { from: "Ada", subject: "Hi" } } : NO_ANSWER()));
    const answer = await email.connect({ address: "me@shop.example", password: PASSWORD });
    expect(answer).toMatchObject({ ok: true, inbox: { messages: 30, newest: { from: "Ada", subject: "Hi" } }, account: { address: "me@shop.example", imapHost: "imap.shop.example", smtpHost: "smtp.shop.example" }, sending: { ok: true } });
    expect(email.status()).toMatchObject({ state: "connected", accounts: [{ address: "me@shop.example" }] });
    expect(JSON.stringify(answer)).not.toContain(PASSWORD);
    expect(JSON.stringify(email.status())).not.toContain(PASSWORD);
  });

  it("a mailbox whose headers can't be read is not connected", async () => {
    const { email } = service(() => new EmailError("server", "The mailbox opened, but its messages' headers could not be read."));
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD, imapHost: "imap.shop.example" })).toMatchObject({ ok: false, needsServer: true });
    expect(email.status().state).toBe("signed-out");
  });

  it("a refused password stops there: it goes to no other host, and the person is told plainly", async () => {
    const { email, tried } = service(WRONG);
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toEqual({ ok: false, error: "The mail server did not accept this address and password. Check them and try again." });
    expect(tried).toEqual(["imap.shop.example:993:me@shop.example", "imap.shop.example:993:me"]);
    expect(email.status().state).toBe("signed-out");
  });

  it("a host that takes the short name works", async () => {
    const { email } = service((_imap, username) => (username === "me" ? { messages: 1 } : WRONG()));
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toMatchObject({ ok: true });
    expect(email.store.get("me@shop.example")?.username).toBe("me");
  });

  it("the big providers' password rules are said in words", async () => {
    const { email } = service(WRONG);
    expect(await email.connect({ address: "me@gmail.com", password: PASSWORD })).toMatchObject({ ok: false, error: expect.stringContaining("app password") });
    expect(await email.connect({ address: "me@outlook.com", password: PASSWORD })).toMatchObject({ ok: false, error: expect.stringContaining("Microsoft") });
  });

  it("nothing found asks for the server, and a typed one is used alone", async () => {
    const { email, tried, sent } = service((imap) => (imap.host === "post.hoster.example" ? { messages: 2 } : NO_ANSWER()));
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toMatchObject({ ok: false, needsServer: true });
    tried.length = 0;
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD, imapHost: "post.hoster.example", smtpHost: "out.hoster.example", smtpPort: 2525, username: "m1" })).toMatchObject({ ok: true });
    expect(tried).toEqual(["post.hoster.example:993:m1"]);
    expect(sent).toEqual(["out.hoster.example:2525"]);
  });

  it("typing only the incoming server still finds the outgoing one beside it", async () => {
    const { email, sent } = service((imap) => (imap.host === "imap.world4you.com" ? { messages: 2 } : NO_ANSWER()), (host) => (host === "smtp.world4you.com" ? undefined : NO_ANSWER()));
    expect(await email.connect({ address: "office@small-shop.at", password: PASSWORD, imapHost: "imap.world4you.com" })).toMatchObject({ ok: true, sending: { ok: true }, account: { smtpHost: "smtp.world4you.com" } });
    expect(sent[0]).toBe("smtp.world4you.com:587");
  });

  it("a typed port says how it speaks TLS: the well-known ports as they are, any other tried in TLS first, then upgraded", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const dataDir = mkdtempSync(join(tmpdir(), "omb-mail-service-")); dirs.push(dataDir);
    const email = createEmailService({ dataDir, publicOnly: false, discover: NOWHERE, guard: openGuard, test: {
      mailbox: (async (account: { imap: Record<string, unknown> }) => { seen.push(account.imap); return { messages: 1 }; }) as never,
      sending: (async (login: unknown, server: Record<string, unknown>) => { if (login) seen.push(server); }) as never,
    } });
    for (const [imapPort, smtpPort] of [[993, 465], [143, 587], [10143, 2525]]) await email.connect({ address: "me@shop.example", password: PASSWORD, imapHost: "a.example", imapPort, smtpHost: "b.example", smtpPort });
    expect(seen.map((server) => [server.port, server.secure])).toEqual([[993, true], [465, true], [143, false], [587, false], [10143, true], [2525, true]]);
  });

  it("reading can work while sending doesn't, and it says so in one sentence naming where it looked", async () => {
    const { email, sent } = service(() => ({ messages: 2 }), () => SILENT());
    const problem = "No outgoing mail server answered: smtp.shop.example, mail.shop.example, imap.shop.example on 465 or 587.";
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toMatchObject({ ok: true, sending: { ok: false, problem } });
    expect(email.status().accounts[0]).toMatchObject({ sendingProblem: problem, smtpTried: { smtpHost: "smtp.shop.example" } });
    expect(email.status().accounts[0]!.problem).toBeUndefined();
    expect(email.store.get("me@shop.example")?.smtp).toBeUndefined();
    expect(sent, "the password went nowhere that didn't answer").toEqual([]);
    expect(email.sendingProblem("me@shop.example")).toBe(problem);
  });

  it("a refused outgoing password: tried under the other user names on that server only, then said plainly", async () => {
    const { email, logins } = service(() => ({ messages: 2 }), (_host, login) => (login ? REFUSED() : undefined));
    const problem = "The outgoing server smtp.shop.example:587 refused the password.";
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toMatchObject({ ok: true, sending: { ok: false, problem }, account: { sendingProblem: problem } });
    expect(logins).toEqual([`smtp.shop.example:me@shop.example:${PASSWORD}`, `smtp.shop.example:me:${PASSWORD}`]);
  });

  it("sends with the short name where only that works", async () => {
    const { email } = service(() => ({ messages: 2 }), (host, login) => (host !== "smtp.shop.example" ? SILENT() : login && login.username !== "me" ? REFUSED() : undefined));
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toMatchObject({ ok: true, sending: { ok: true } });
    expect(email.store.get("me@shop.example")).toMatchObject({ username: "me@shop.example", smtpUsername: "me" });
  });

  it("the servers found for the address come before the ones beside the incoming server", async () => {
    const autoconfig = `<clientConfig><emailProvider id="x"><incomingServer type="imap"><hostname>imap.hoster.example</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
      <outgoingServer type="smtp"><hostname>out.hoster.example</hostname><port>465</port><socketType>SSL</socketType></outgoingServer></emailProvider></clientConfig>`;
    const { email, sent } = service(() => ({ messages: 1 }), () => {}, { discover: { fetchText: async (url) => (url.includes("autoconfig.shop.example") ? autoconfig : null) } });
    await email.connect({ address: "me@shop.example", password: PASSWORD });
    expect(sent).toEqual(["out.hoster.example:465"]);
  });

  it("a found server answered the other way round on its port is reached that way", async () => {
    const { email } = service(() => ({ messages: 1 }), (host, _login, server) => (host === "smtp.shop.example" && server.port === 587 && server.secure ? undefined : SILENT()));
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toMatchObject({ ok: true, account: { smtpHost: "smtp.shop.example", smtpPort: 587, smtpSecurity: "tls" } });
  });

  it("Gmail and Outlook say what they need in one line, and Outlook never gets the password", async () => {
    const google = service(WRONG);
    expect(await google.email.connect({ address: "me@gmail.com", password: PASSWORD })).toEqual({ ok: false, error: expect.stringContaining("app password"), signIn: { provider: "Google", app: "gmail", appPasswordUrl: "https://myaccount.google.com/apppasswords" } });
    const microsoft = service(WRONG);
    expect(await microsoft.email.connect({ address: "me@outlook.com", password: PASSWORD })).toEqual({ ok: false, error: expect.stringContaining("sign in with Microsoft"), signIn: { provider: "Microsoft", app: "outlook" } });
    expect(microsoft.tried).toEqual([]);
  });

  it("an app password that reads but doesn't send at Google says what to do instead", async () => {
    const { email } = service(() => ({ messages: 1 }), (_host, login) => (login ? REFUSED() : undefined));
    expect(await email.connect({ address: "me@gmail.com", password: PASSWORD })).toMatchObject({ ok: true, sending: { ok: false, problem: expect.stringContaining("connect Gmail in Connected apps"), signIn: { app: "gmail" } } });
  });

  it("sending is checked again on its own: reading isn't signed in again, a server that works is kept, and one typed that fails changes nothing", async () => {
    let up = false;
    const { email, tried, sent } = service(() => ({ messages: 1 }), (host) => (up && host === "smtp.shop.example" ? undefined : SILENT()));
    await email.connect({ address: "me@shop.example", password: PASSWORD });
    tried.length = 0;
    expect(await email.checkOutgoing("me@shop.example", {})).toMatchObject({ ok: false, account: { sendingProblem: expect.stringContaining("No outgoing mail server answered") } });
    up = true;
    expect(await email.checkOutgoing("me@shop.example", {})).toMatchObject({ ok: true, account: { smtpHost: "smtp.shop.example" } });
    expect(tried, "reading was not signed in again").toEqual([]);
    expect(email.status().accounts[0]!.sendingProblem).toBeUndefined();
    sent.length = 0;
    expect(await email.checkOutgoing("me@shop.example", { smtpHost: "other.shop.example", smtpPort: 2525, smtpSecurity: "starttls" })).toMatchObject({ ok: false, error: "other.shop.example didn't answer on 2525." });
    expect(email.store.get("me@shop.example")?.smtp).toMatchObject({ host: "smtp.shop.example" });
    expect(email.status().accounts[0]!.sendingProblem).toBeUndefined();
    expect(await email.checkOutgoing("me@shop.example", { smtpHost: "bad host;x" })).toMatchObject({ ok: false });
    expect(await email.checkOutgoing("nobody@shop.example", {})).toMatchObject({ ok: false });
  });

  it("the outgoing server typed by hand, with its own sign-in, is the only place its password goes", async () => {
    const { email, logins } = service(() => ({ messages: 1 }), (host, login) => (host !== "out.hoster.example" ? SILENT() : login && login.password !== "fake-outgoing-2" ? REFUSED() : undefined));
    await email.connect({ address: "me@shop.example", password: PASSWORD });
    logins.length = 0;
    expect(await email.checkOutgoing("me@shop.example", { smtpHost: "out.hoster.example", smtpPort: 465, smtpSecurity: "tls", smtpUsername: "sender-7", smtpPassword: "fake-outgoing-2" })).toMatchObject({ ok: true, account: { smtpHost: "out.hoster.example", smtpUsername: "sender-7" } });
    expect(logins).toEqual(["out.hoster.example:sender-7:fake-outgoing-2"]);
    expect(email.store.get("me@shop.example")).toMatchObject({ password: PASSWORD, smtpUsername: "sender-7", smtpPassword: "fake-outgoing-2" });
    expect(JSON.stringify(email.status())).not.toContain("fake-outgoing-2");
    expect(email.scrub("x fake-outgoing-2 y")).not.toContain("fake-outgoing-2");
  });

  it("a test goes from the mailbox to itself, and only once it sends", async () => {
    const sentTo: unknown[] = [];
    const { email } = service(() => ({ messages: 1 }), (host) => (host === "smtp.shop.example" ? undefined : SILENT()), { send: (_account, input) => sentTo.push(input) });
    await email.connect({ address: "me@shop.example", password: PASSWORD });
    expect(await email.sendTest("me@shop.example")).toEqual({ ok: true });
    expect(sentTo).toMatchObject([{ to: ["me@shop.example"] }]);
    const { email: unsent } = service(() => ({ messages: 1 }), () => SILENT());
    await unsent.connect({ address: "me@shop.example", password: PASSWORD });
    expect(await unsent.sendTest("me@shop.example")).toMatchObject({ ok: false, error: expect.stringContaining("No outgoing mail server answered") });
  });

  it("the plain words of a send's failure name the server and never the server's own text", () => {
    const server = { host: "smtp.shop.example", port: 587, secure: false };
    expect(sendingError(Object.assign(new Error("535 secret detail from the server"), { code: "EAUTH", responseCode: 535 }), server).message).toBe("The outgoing server smtp.shop.example:587 refused the password.");
    expect(sendingError(Object.assign(new Error("Greeting never received"), { code: "ETIMEDOUT" }), { ...server, port: 465 }).message).toBe("smtp.shop.example:465 expects SSL/TLS from the first byte; choose SSL/TLS for it, not STARTTLS.");
    expect(sendingError(Object.assign(new Error("ssl3_get_record:wrong version number"), { code: "ESOCKET" }), { ...server, secure: true }).message).toBe("smtp.shop.example:587 starts without TLS and upgrades with STARTTLS; choose STARTTLS for it, not SSL/TLS.");
    expect(sendingError(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "EDNS" }), server).message).toBe("There is no mail server called smtp.shop.example.");
  });

  it("a mailbox saved read-only, which said so as its problem, is not held back by it", async () => {
    const { email, dataDir } = service(() => ({ messages: 1 }), () => SILENT());
    await email.connect({ address: "me@shop.example", password: PASSWORD });
    const saved = email.store.get("me@shop.example")!;
    const { sendingProblem: _problem, ...rest } = saved;
    email.store.put({ ...rest, problem: "Reading works. Sending doesn't yet: No outgoing mail server was found." });
    const again = service(() => ({ messages: 1 }), undefined, { dataDir }).email;
    expect(again.store.get("me@shop.example")?.problem).toBeUndefined();
    expect(again.sendingProblem("me@shop.example")).toBe("No outgoing server is set for sending.");
  });

  it("refuses what isn't an address or a host, and more mailboxes than it keeps", async () => {
    const { email } = service(() => ({ messages: 1 }));
    expect(await email.connect({ address: "not an address", password: PASSWORD })).toMatchObject({ ok: false });
    expect(await email.connect({ address: "me@shop.example", password: "" })).toMatchObject({ ok: false });
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD, imapHost: "bad host;x" })).toMatchObject({ ok: false, needsServer: true });
    for (let n = 0; n < MAX_EMAIL_ACCOUNTS; n++) expect((await email.connect({ address: `m${n}@shop.example`, password: PASSWORD })).ok).toBe(true);
    expect(await email.connect({ address: "more@shop.example", password: PASSWORD })).toMatchObject({ ok: false, error: expect.stringContaining(String(MAX_EMAIL_ACCOUNTS)) });
    expect((await email.connect({ address: "m0@shop.example", password: `${PASSWORD}-new` })).ok, "the same address is replaced").toBe(true);
  });

  it("on a Cloud home reaches only the public internet, whatever host is typed, and never tries the password elsewhere", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-mail-service-")); dirs.push(dataDir);
    const cloud = createEmailService({ dataDir, publicOnly: true, discover: NOWHERE });
    for (const imapHost of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "localhost"]) {
      expect(await cloud.connect({ address: "me@shop.example", password: PASSWORD, imapHost }), imapHost).toEqual({ ok: false, needsServer: true, error: "My Cloud can only reach mail servers on the public internet." });
    }
    expect(cloud.status().state).toBe("signed-out");
  }, 30_000);

  it("is off where a place refuses it", async () => {
    const { email, tried } = service(() => ({ messages: 1 }), undefined, { refusal: "Not here." });
    expect(email.status()).toEqual({ state: "unavailable", accounts: [], reason: "Not here." });
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toEqual({ ok: false, error: "Not here." });
    expect(tried).toEqual([]);
    expect(email.mounted()).toBe(false);
  });

  it("rests sealed: no password in any file, owner-only, and back after a restart", async () => {
    const { email, dataDir } = service(() => ({ messages: 1 }));
    await email.connect({ address: "me@shop.example", password: PASSWORD });
    for (const name of readdirSync(dataDir)) {
      expect(readFileSync(join(dataDir, name)).toString("latin1"), name).not.toContain(PASSWORD);
      // Windows has no POSIX mode bits; its files are private to the user by their folder.
      if (process.platform !== "win32") expect(statSync(join(dataDir, name)).mode & 0o077, name).toBe(0);
    }
    expect(service(() => ({ messages: 1 }), undefined, { dataDir }).email.store.get("me@shop.example")?.password).toBe(PASSWORD);
  });

  it("masks a saved password in whatever a bot or a transcript reads, in any form", async () => {
    const { email } = service(() => ({ messages: 1 }));
    await email.connect({ address: "me@shop.example", password: "p&ss w<rd" });
    expect(email.scrub("before p&ss w<rd after")).not.toContain("p&ss w<rd");
    expect(email.scrub(encodeURIComponent("p&ss w<rd"))).not.toContain("w%3Crd");
    expect(email.scrub("nothing here")).toBe("nothing here");
    expect(email.longest(), "its HTML form; the percent-encoded ones are plain ASCII, never cut partway").toBe("p&amp;ss w&lt;rd".length);
  });

  it("takes mailboxes moved from a computer, keeping one already here", async () => {
    const { email } = service(() => ({ messages: 1 }));
    await email.connect({ address: "here@shop.example", password: "fake-here-password" });
    const moved = (address: string) => ({ address, username: address, password: PASSWORD, imap: { host: "imap.shop.example", port: 993, secure: true }, connectedAt: 1 });
    expect(email.adopt([moved("here@shop.example"), moved("new@shop.example"), { address: "broken" }])).toEqual({ adopted: 1, kept: 1 });
    expect(email.store.get("here@shop.example")?.password).toBe("fake-here-password");
    expect(email.store.get("new@shop.example")?.password).toBe(PASSWORD);
  });
});
