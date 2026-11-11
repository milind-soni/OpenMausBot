// The person's mailboxes: connecting one (find its servers, prove it reads a real header, keep the password sealed),
// what the app shows of them, and a guard over where they connect. Shared by the Apps card, the card in a chat and a
// move from the person's computer.
import { EMAIL_SLUG, type EmailAccountView, type EmailConnectAnswer, type EmailConnectRequest, type EmailOutgoingAnswer, type EmailOutgoingFields, type EmailSignInHint, type EmailStatus, type EmailTestAnswer } from "../../shared/email.ts";
import { boxRefusal } from "../bot-box/egress-gate.ts";
import { resolveTarget } from "../browser/egress/gate.ts";
import { secretForms } from "../vault-store.ts";
import { HELD_SECRET_MASK, longestForm } from "../redact.ts";
import { EmailError, LASTING_SENDING_FAULTS, openGuard, pinned, sendingError, sendMessage, SendingError, testMailbox, testSending, type EmailGuard, type SendingFault } from "./client.ts";
import { discoverMailServers, liveDiscoverDeps, smtpBeside, type DiscoverDeps, type MailCandidates } from "./discover.ts";
import { EmailStore, MAX_EMAIL_ACCOUNTS, parseEmailAccount, type EmailAccount, type EmailServer } from "./store.ts";

const ADDRESS = /^[^\s@<>()",;:]{1,200}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/iu;
const HOST = /^[a-z0-9.-]{1,253}$/iu;
/** How long connecting may look for a server that answers. */
const FIND_MS = 60_000;
/** How long the password may go round the outgoing servers that answered. */
const SIGN_IN_MS = 60_000;

export interface EmailServiceDeps {
  dataDir: string;
  /** A Cloud home: only public addresses, as a bot's own way out. */
  publicOnly: boolean;
  /** Why mailboxes can't be connected here; none where they can. */
  refusal?: string | null;
  /** Test seams. */
  discover?: DiscoverDeps;
  guard?: EmailGuard;
  test?: { mailbox: typeof testMailbox; sending: typeof testSending; send?: typeof sendMessage };
  now?(): number;
}

/** The Cloud's rule for where mail goes: refused for anything but the public internet, and connected to the address checked. */
const publicGuard: EmailGuard = async ({ host, port }) => {
  const addresses = await resolveTarget(host);
  if (!addresses.length) throw new EmailError("network", "The mail server's name could not be found.");
  if (await boxRefusal({ host, port }, addresses)) throw new EmailError("refused", "My Cloud can only reach mail servers on the public internet.");
  return pinned(host, addresses[0]!.address);
};

/** Why this mailbox can't send, in one sentence; none while it can. */
export const sendingProblem = (account: EmailAccount): string | undefined => account.sendingProblem ?? (account.smtp ? undefined : "No outgoing server is set for sending.");

const security = (server: EmailServer) => (server.secure ? "tls" as const : "starttls" as const);

const view = (account: EmailAccount): EmailAccountView => {
  const sending = sendingProblem(account);
  return {
    address: account.address, imapHost: account.imap.host,
    ...(account.smtp ? { smtpHost: account.smtp.host, smtpPort: account.smtp.port, smtpSecurity: security(account.smtp) } : {}),
    ...(!account.smtp && account.smtpTried ? { smtpTried: { smtpHost: account.smtpTried.host, smtpPort: account.smtpTried.port, smtpSecurity: security(account.smtpTried) } } : {}),
    ...(account.smtpUsername ? { smtpUsername: account.smtpUsername } : {}),
    connectedAt: new Date(account.connectedAt).toISOString(), ...(account.problem ? { problem: account.problem } : {}), ...(sending ? { sendingProblem: sending } : {}),
  };
};

/** The places a typed port means: the first port of each pair starts in TLS, the second upgrades to it; any other port
 * is tried both ways, TLS first (an upgrade on a TLS port only times out). Either way the password goes only once TLS is up. */
function onPort(host: string, port: number | undefined, [tls, upgraded]: [number, number]): EmailServer[] {
  return port === tls ? [{ host, port, secure: true }] : port === upgraded ? [{ host, port, secure: false }]
    : port ? [{ host, port, secure: true }, { host, port, secure: false }] : [{ host, port: tls, secure: true }, { host, port: upgraded, secure: false }];
}

function typedOutgoing(fields: EmailOutgoingFields): EmailServer[] | null {
  const host = fields.smtpHost?.trim().toLowerCase();
  if (!host) return null;
  if (fields.smtpSecurity) return [{ host, port: fields.smtpPort ?? (fields.smtpSecurity === "tls" ? 465 : 587), secure: fields.smtpSecurity === "tls" }];
  return onPort(host, fields.smtpPort, [465, 587]);
}

/** A server's answer that says the most: one that spoke beats one that didn't, and silence beats a name that isn't there. */
const TELLING: readonly SendingFault[] = ["password", "refused", "no-sign-in", "no-tls", "wrong-security", "server", "rejected", "certificate", "no-answer", "missing"];
const telling = (misses: readonly SendingError[]) => [...misses].sort((a, b) => TELLING.indexOf(a.fault) - TELLING.indexOf(b.fault))[0];

/** Why no outgoing server would do, in one sentence, and the server it is about: what one that answered said, else which
 * were silent and where. */
function sendingSummary(misses: readonly SendingError[]): { problem: string; tried?: EmailServer } {
  const told = telling(misses.filter((miss) => miss.fault !== "no-answer" && miss.fault !== "missing"));
  if (told) return { problem: told.message, tried: told.server };
  const silent = misses.filter((miss) => miss.fault === "no-answer");
  if (!silent.length) return { problem: "No outgoing mail server was found for this address." };
  const hosts = [...new Set(silent.map((miss) => miss.server.host))];
  const ports = [...new Set(silent.map((miss) => miss.server.port))].sort((a, b) => a - b);
  const on = ports.length > 1 ? `${ports.slice(0, -1).join(", ")} or ${ports.at(-1)}` : String(ports[0]);
  const problem = hosts.length === 1 ? `${hosts[0]} didn't answer on ${on}.` : `No outgoing mail server answered: ${hosts.slice(0, 3).join(", ")}${hosts.length > 3 ? " and more" : ""} on ${on}.`;
  return { problem, tried: silent[0]!.server };
}

/** What a provider needs instead of the mailbox password for sending, after the sentence that says it was refused. */
function sendingHint(hint: EmailSignInHint | undefined): string {
  if (hint?.app === "outlook") return " Microsoft is turning off password sign-in for sending (off by default from December 2026): connect Outlook in Connected apps instead.";
  if (hint?.app === "gmail") return " Google needs an app password for this, made with 2-step verification on, or connect Gmail in Connected apps instead.";
  if (hint) return ` ${hint.provider} needs an app password for this, made in the account's security settings.`;
  return "";
}

type Login = { username: string; password: string };
type Sending = { smtp: EmailServer; login: Login } | { problem: string; tried?: EmailServer };

export function createEmailService(deps: EmailServiceDeps) {
  const store = new EmailStore(deps.dataDir);
  /** Masks every saved password, in every form it might be written, in whatever a bot or a transcript can read. */
  const scrub = (text: string) => store.secretValues().flatMap(secretForms).reduce((safe, form) => (safe.includes(form) ? safe.split(form).join(HELD_SECRET_MASK) : safe), text);
  const guard = deps.guard ?? (deps.publicOnly ? publicGuard : openGuard);
  const live = { mailbox: testMailbox, sending: testSending, send: sendMessage, ...deps.test };
  const allowed = async (url: URL) => {
    if (!deps.publicOnly) return true;
    await publicGuard({ host: url.hostname, port: 443 });
    return true;
  };
  const discover = deps.discover ?? liveDiscoverDeps(allowed);
  const now = deps.now ?? Date.now;

  const status = (): EmailStatus => (deps.refusal
    ? { state: "unavailable", accounts: [], reason: deps.refusal }
    : { state: store.list().length ? "connected" : "signed-out", accounts: store.list().map(view) });

  /** Tries each place in turn. A server that refuses the password ends it there: the password goes to no other host. */
  async function signIn(address: string, password: string, username: string | undefined, found: MailCandidates, deadline: number) {
    const local = address.slice(0, address.lastIndexOf("@"));
    const names = username ? [username] : found.username === "localpart" ? [local] : found.username === "address" ? [address] : [address, local];
    let last: EmailError | null = null;
    for (const imap of found.imap) {
      if (now() > deadline) break;
      for (const name of names) {
        try {
          return { imap, username: name, inbox: await live.mailbox({ username: name, password, imap }, guard) };
        } catch (error) {
          const failed = error instanceof EmailError ? error : new EmailError("network", "The mail server did not answer.");
          if (failed.code !== "password") { last = failed; break; }
          last = failed;
          if (name === names.at(-1)) throw failed;
        }
      }
    }
    return last ?? new EmailError("network", "No mail server was found for this address.");
  }

  /** An outgoing server that answers over TLS with a sign-in on offer, or why not. No password goes. Found places are
   * reached in either way of starting TLS (a server may start TLS on 587, or upgrade on 465); a way the person chose is
   * reached only that way, so a mix-up is said as one. */
  async function reach(server: EmailServer, exact: boolean): Promise<EmailServer | SendingError> {
    const ways = exact ? [server] : [server, { ...server, secure: !server.secure }];
    try {
      return await Promise.any(ways.map(async (way) => { await live.sending(null, way, guard); return way; }));
    } catch (error) {
      const misses = ways.map((way, index) => sendingError((error as AggregateError).errors[index], way));
      return misses.find((miss) => miss.fault !== "no-answer") ?? misses[0]!;
    }
  }

  /** The first outgoing server that takes one of these sign-ins (the same password under another user name), or why none
   * would. Every place is reached at once without the password; then it goes, in order, only to those that answered,
   * and a refusal ends it there: it goes to no other host. */
  async function findSending(logins: readonly Login[], candidates: readonly EmailServer[], options: { exact?: boolean; hint?: EmailSignInHint } = {}): Promise<Sending> {
    const places = candidates.filter((server, index) => candidates.findIndex((other) => other.host === server.host && other.port === server.port) === index);
    const reached = places.map((server) => reach(server, options.exact === true));
    const misses: SendingError[] = [];
    const deadline = now() + SIGN_IN_MS;
    for (const answer of reached) {
      const server = await answer;
      if (server instanceof SendingError) { misses.push(server); continue; }
      if (now() > deadline) break;
      let refused: SendingError | undefined;
      for (const login of logins) {
        try {
          await live.sending(login, server, guard);
          return { smtp: server, login };
        } catch (error) {
          const failed = sendingError(error, server);
          if (failed.fault !== "password") { misses.push(failed); refused = undefined; break; }
          refused = failed;
        }
      }
      if (refused) return { problem: refused.message + sendingHint(options.hint), tried: server };
    }
    return sendingSummary(misses);
  }

  /** The user names to send with: one typed, else the one reading took, then the address or its local part. */
  const sendingNames = (address: string, reading: string, typed: string | undefined): string[] => {
    if (typed) return [typed];
    const local = address.slice(0, address.lastIndexOf("@"));
    return [...new Set([reading, address, local])];
  };

  /** The outgoing sign-in to keep: only what differs from the incoming one. */
  const ownLogin = (login: Login, account: Pick<EmailAccount, "username" | "password">) => ({
    ...(login.username !== account.username ? { smtpUsername: login.username } : {}),
    ...(login.password !== account.password ? { smtpPassword: login.password } : {}),
  });

  const outgoingHostProblem = (fields: EmailOutgoingFields) => (fields.smtpHost?.trim() && !HOST.test(fields.smtpHost.trim()) ? "A mail server is a name like mail.example.com." : null);

  return {
    store,
    guard,
    status,
    scrub,
    /** The length of the longest saved password, in any form. */
    longest: () => longestForm(store.secretValues().flatMap(secretForms)),
    mounted: () => !deps.refusal && store.list().length > 0,
    slug: EMAIL_SLUG,
    /** Why this mailbox can't send, or nothing while it can. */
    sendingProblem: (address: string): string | undefined => { const account = store.get(address); return account ? sendingProblem(account) : undefined; },

    /** Connects a mailbox, or says why not. Nothing is saved until a real header has been read back; sending is checked
     * too, and a mailbox that only reads says why it can't send. `reading` hears the incoming server once it took the
     * password, while sending is still being checked. */
    async connect(request: EmailConnectRequest, reading?: (imapHost: string) => void): Promise<EmailConnectAnswer> {
      if (deps.refusal) return { ok: false, error: deps.refusal };
      const address = request.address.trim();
      const password = request.password;
      if (!ADDRESS.test(address)) return { ok: false, error: "Enter your whole email address, like you@example.com." };
      if (!password) return { ok: false, error: "Enter the password for this mailbox." };
      for (const host of [request.imapHost, request.smtpHost]) if (host?.trim() && !HOST.test(host.trim())) return { ok: false, error: "A mail server is a name like mail.example.com.", needsServer: true };
      const existing = store.get(address);
      if (!existing && store.list().length >= MAX_EMAIL_ACCOUNTS) return { ok: false, error: `You can connect at most ${MAX_EMAIL_ACCOUNTS} mailboxes.` };
      const deadline = now() + FIND_MS;
      const imapHost = request.imapHost?.trim().toLowerCase();
      const outgoing = typedOutgoing(request);
      const found: MailCandidates = imapHost && outgoing ? { imap: [], smtp: [] } : await discoverMailServers(address, discover);
      // A provider with no password sign-in at all never gets one.
      if (!imapHost && found.provider?.rule === "no-password") return { ok: false, error: passwordHelp(found.provider), signIn: found.provider.hint };
      if (imapHost) found.imap = onPort(imapHost, request.imapPort, [993, 143]);
      else if (existing) found.imap = [existing.imap, ...found.imap.filter((server) => server.host !== existing.imap.host || server.port !== existing.imap.port)];
      let signedIn: Awaited<ReturnType<typeof signIn>>;
      try { signedIn = await signIn(address, password, request.username?.trim() || undefined, found, deadline); } catch (error) {
        const failed = error instanceof EmailError ? error : new EmailError("server", "The mail server said no.");
        if (failed.code !== "password") return { ok: false, error: failed.message };
        return { ok: false, error: passwordHelp(found.provider), ...(found.provider ? { signIn: found.provider.hint } : {}) };
      }
      if (signedIn instanceof EmailError) {
        if (signedIn.code === "refused") return { ok: false, needsServer: true, error: signedIn.message };
        return { ok: false, needsServer: true, error: imapHost ? "That mail server did not answer over a secure connection. Check its name and port." : "We couldn't find your mail server. Type its name, which your mail provider's help pages list." };
      }
      reading?.(signedIn.imap.host);
      const smtpPassword = request.smtpPassword || password;
      const logins = sendingNames(address, signedIn.username, request.smtpUsername?.trim()).map((username) => ({ username, password: smtpPassword }));
      const places = outgoing ?? [...(existing?.smtp ? [existing.smtp] : []), ...found.smtp, ...smtpBeside(signedIn.imap.host)];
      const sending = await findSending(logins, places, { exact: Boolean(request.smtpSecurity), hint: found.provider?.hint });
      const account: EmailAccount = {
        address, username: signedIn.username, password, imap: signedIn.imap, connectedAt: now(),
        ...("smtp" in sending
          ? { smtp: sending.smtp, ...ownLogin(sending.login, { username: signedIn.username, password }) }
          : { ...ownLogin({ username: request.smtpUsername?.trim() || signedIn.username, password: smtpPassword }, { username: signedIn.username, password }), sendingProblem: sending.problem, ...(sending.tried ? { smtpTried: sending.tried } : {}) }),
      };
      store.put(account);
      const hint = "smtp" in sending ? undefined : found.provider?.hint;
      return { ok: true, account: view(account), inbox: signedIn.inbox, sending: "smtp" in sending ? { ok: true } : { ok: false, problem: sending.problem, ...(hint ? { signIn: hint } : {}) } };
    },

    /** Checks sending again for a connected mailbox, at the outgoing server typed here or the ones found for it, without
     * signing in to read again. A working server is kept; a failed check leaves one that worked as it was. */
    async checkOutgoing(address: string, fields: EmailOutgoingFields): Promise<EmailOutgoingAnswer> {
      if (deps.refusal) return { ok: false, error: deps.refusal };
      const account = store.get(address);
      if (!account) return { ok: false, error: `No mailbox ${address} is connected.` };
      const bad = outgoingHostProblem(fields);
      if (bad) return { ok: false, error: bad };
      const password = fields.smtpPassword || account.smtpPassword || account.password;
      const logins = sendingNames(account.address, account.smtpUsername ?? account.username, fields.smtpUsername?.trim()).map((username) => ({ username, password }));
      const typed = typedOutgoing(fields);
      const found = typed ? null : await discoverMailServers(account.address, discover);
      const places = typed ?? [...(account.smtp ? [account.smtp] : []), ...(account.smtpTried ? [account.smtpTried] : []), ...found!.smtp, ...smtpBeside(account.imap.host)];
      const sending = await findSending(logins, places, { exact: Boolean(fields.smtpSecurity), hint: found?.provider?.hint });
      const current = store.get(address);
      if (!current || current.password !== account.password) return { ok: false, error: "This mailbox changed while sending was checked. Check again." };
      const { smtpUsername: _username, smtpPassword: _password, sendingProblem: _problem, smtpTried: _tried, ...rest } = current;
      if ("smtp" in sending) {
        const next: EmailAccount = { ...rest, smtp: sending.smtp, ...ownLogin(sending.login, current) };
        store.put(next);
        return { ok: true, account: view(next) };
      }
      // A server that sends stays until one typed here works instead.
      if (current.smtp && !current.sendingProblem) return { ok: false, error: sending.problem };
      const { smtp: _smtp, ...unsent } = rest;
      const next: EmailAccount = { ...unsent, ...ownLogin({ username: logins[0]!.username, password }, current), sendingProblem: sending.problem, ...(sending.tried ? { smtpTried: sending.tried } : {}) };
      store.put(next);
      return { ok: false, error: sending.problem, account: view(next) };
    },

    /** Sends a short message from a mailbox to itself: sending proven end to end. */
    async sendTest(address: string): Promise<EmailTestAnswer> {
      if (deps.refusal) return { ok: false, error: deps.refusal };
      const account = store.get(address);
      if (!account) return { ok: false, error: `No mailbox ${address} is connected.` };
      const problem = sendingProblem(account);
      if (problem) return { ok: false, error: problem };
      try {
        await live.send(account, guard, { to: [account.address], subject: "OpenMausBot test", text: `This message is a test from OpenMausBot: sending from ${account.address} works.` });
        return { ok: true };
      } catch (error) {
        if (error instanceof SendingError && LASTING_SENDING_FAULTS.has(error.fault)) store.markSendingProblem(account, error.message);
        return { ok: false, error: error instanceof EmailError ? error.message : "The test message could not be sent." };
      }
    },

    disconnect(address: string): EmailStatus {
      store.remove(address);
      return status();
    },

    /** A mailbox that moved from the person's computer, with its password; My Cloud keeps one of its own at that address. */
    adopt(values: unknown[]): { adopted: number; kept: number } {
      let adopted = 0, kept = 0;
      for (const value of values) {
        const account = parseEmailAccount(value);
        if (!account) continue;
        if (store.get(account.address) || store.list().length >= MAX_EMAIL_ACCOUNTS) { kept++; continue; }
        store.put(account);
        adopted++;
      }
      return { adopted, kept };
    },
  };
}

export type EmailService = ReturnType<typeof createEmailService>;

/** Why a password failed, with what the big providers need instead, in one line. */
function passwordHelp(provider: MailCandidates["provider"]): string {
  if (provider?.hint.app === "outlook") return "Microsoft doesn't let mail programs in with a password: sign in with Microsoft instead.";
  if (provider?.hint.app === "gmail") return "Google needs an app password here (with 2-step verification on), or sign in with Google instead.";
  if (provider) return `${provider.hint.provider} needs an app password here, made in your account's security settings, not your normal password.`;
  return "The mail server did not accept this address and password. Check them and try again.";
}
