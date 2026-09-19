// The account-facing commands: `status`, `access`, `login`, `logout`, `browser`.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseAllowList } from "../account-signin.ts";
import { writeFileAtomic } from "../atomic.ts";
import { createTunnelAccount, describeTunnelAccount, FLEET_CREDENTIAL_ENV, fleetCredential } from "../tunnel.ts";
import { message } from "./client.ts";
import { defaultIo, serverVersion, type CliIo, type CliOptions } from "./options.ts";

export async function runStatus(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  let code = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${options.port}/.well-known/openmausbot/environment`);
    const body: any = await res.json();
    io.log(options.json ? JSON.stringify(body, null, 2) : `${body.label} · OpenMausBot ${body.version} on ${body.platform} · id ${body.environmentId}`);
  } catch {
    io.error(`no OpenMausBot server on http://127.0.0.1:${options.port}`);
    code = 1;
  }
  if (!options.json) {
    const account = describeTunnelAccount(createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() }).credentials.read());
    if (fleetCredential()) io.log(`public address: managed by the fleet (${FLEET_CREDENTIAL_ENV} is set; the address is fetched when serve --tunnel starts)`);
    else if (account.address) io.log(`public address: ${account.address} (signed in as ${account.email ?? "?"}; serve it with --tunnel)`);
  }
  return code;
}

/** The sign-in allow-list, edited straight in config.json: the server reads
 * it per request, so this works with the server running or stopped and
 * needs no restart. Environment variables (OMB_SIGNIN_EMAILS) win when set.
 * Written the way the server writes it (atomic, 0600), touching only the
 * one key, so nothing else in the file moves. */
export async function runAccess(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const file = join(options.dataDir, "config.json");
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      raw = Object.fromEntries(Object.entries(parsed));
    } catch (error) {
      io.error(`${file} could not be read (${message(error)}); fix it before changing who can sign in`);
      return 1;
    }
  }
  const current = typeof raw.signIn === "object" && raw.signIn !== null ? Object(raw.signIn) : {};
  const list = (value: unknown) => parseAllowList(Array.isArray(value) ? value.map(String).join(",") : "");
  const admins = list(Reflect.get(current, "admins"));
  const members = list(Reflect.get(current, "members"));
  const overridden = process.env.OMB_SIGNIN_EMAILS !== undefined || process.env.OMB_SIGNIN_MEMBER_EMAILS !== undefined;
  const write = (next: { admins: string[]; members: string[] }) => {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify({ ...raw, signIn: next }, null, 2)}\n`, { mode: 0o600 });
  };
  if (options.accessAction === "list") {
    if (!admins.length && !members.length) {
      io.log("nobody can sign in with an email yet; pairing codes only. Add someone with: openmausbot access add you@example.com");
      return 0;
    }
    for (const entry of admins) io.log(`${entry.padEnd(40)} full access`);
    for (const entry of members) io.log(`${entry.padEnd(40)} chat and approvals`);
    if (overridden) io.log("(OMB_SIGNIN_EMAILS / OMB_SIGNIN_MEMBER_EMAILS are set in the environment and win over this list while the server runs)");
    return 0;
  }
  const entry = (options.email ?? "").trim().toLowerCase();
  if (!entry || (!entry.startsWith("@") && !entry.includes("@")) || /\s/.test(entry)) {
    io.error("give an email address, or @domain for everyone at that domain");
    return 2;
  }
  const without = (items: string[]) => items.filter((item) => item !== entry);
  if (options.accessAction === "remove") {
    if (!admins.includes(entry) && !members.includes(entry)) {
      io.error(`${entry} is not on the list`);
      return 1;
    }
    write({ admins: without(admins), members: without(members) });
    io.log(`${entry} can no longer sign in (existing sessions stay until they expire or are revoked with \`openmausbot sessions revoke\`)`);
    return 0;
  }
  write(options.chatOnly ? { admins: without(admins), members: [...without(members), entry] } : { admins: [...without(admins), entry], members: without(members) });
  io.log(`${entry} can sign in at /pair with an emailed code (${options.chatOnly ? "chat and approvals" : "full access"})`);
  if (overridden) io.log("note: OMB_SIGNIN_EMAILS / OMB_SIGNIN_MEMBER_EMAILS are set in the environment and win over this list while the server runs");
  return 0;
}

export async function runLogin(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const account = createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() });
  if (fleetCredential()) io.log(`note: ${FLEET_CREDENTIAL_ENV} is set, so serve --tunnel will use that credential rather than this account`);
  if (account.credentials.status === "unavailable") {
    io.error(`${account.credentials.file} exists but could not be read; fix or remove it, then try again`);
    return 1;
  }
  if (!account.controlPlane) {
    io.error("OMB_CONTROL_PLANE_URL is set but is not an https address");
    return 1;
  }
  const existing = describeTunnelAccount(account.credentials.read());
  if (existing.address) io.log(`already signed in as ${existing.email ?? "?"} (${existing.address}); signing in again refreshes it`);
  const email = (options.email ?? (await io.ask("Email for your OpenMausBot account: "))).trim();
  if (!email) {
    io.error("an email address is needed: openmausbot login --email you@example.com");
    return 1;
  }
  try {
    await account.service.requestCode(email);
  } catch (error) {
    io.error(`could not send a sign-in code: ${message(error)}`);
    return 1;
  }
  const code = (await io.ask(`Enter the 8-digit code we emailed to ${email}: `)).trim();
  let state;
  try {
    state = await account.service.verifyCode(email, code);
  } catch (error) {
    io.error(`sign-in failed: ${message(error)}`);
    return 1;
  }
  const signedIn = describeTunnelAccount(account.credentials.read());
  if (!signedIn.address) {
    io.error(`signed in, but no public address was issued${state.message ? `: ${state.message}` : ""}`);
    return 1;
  }
  io.log(`Signed in as ${signedIn.email ?? email}.`);
  io.log(`This machine's public address: ${signedIn.address}`);
  io.log("Serve there with:  openmausbot serve --tunnel");
  return 0;
}

export async function runLogout(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const account = createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() });
  const before = describeTunnelAccount(account.credentials.read());
  if (!before.email) {
    io.log("this machine is not signed in");
    return 0;
  }
  let state;
  try {
    state = await account.service.signOut();
  } catch (error) {
    io.error(`sign-out failed: ${message(error)}`);
    return 1;
  }
  const after = describeTunnelAccount(account.credentials.read());
  if (after.email) {
    io.error(`still signed in${state.message ? `: ${state.message}` : ""}`);
    return 1;
  }
  io.log(`Signed out ${before.email}${before.address ? `; ${before.address} is released` : ""}.`);
  return 0;
}

export async function runBrowser(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const { browserEngineStatus, describeBrowserEngine, ensureChrome, installAgentBrowserBinary, resolveAgentBrowserBinary } = await import("../browser-engine.ts");
  const status = browserEngineStatus({ dataDir: options.dataDir });
  if (options.browserAction === "status") {
    io.log(describeBrowserEngine(status));
    if (status.kind !== "ready" && status.installable) io.log("install it with:  openmausbot browser install");
    return status.kind === "ready" ? 0 : 1;
  }
  let binary = resolveAgentBrowserBinary({ dataDir: options.dataDir });
  if (binary) {
    io.log(`agent-browser is already here: ${binary}`);
  } else {
    if (status.kind !== "ready" && !status.installable) {
      io.error(status.reason);
      return 1;
    }
    try {
      binary = await installAgentBrowserBinary({ dataDir: options.dataDir, log: io.log });
    } catch (error) {
      io.error(`could not install agent-browser: ${message(error)}`);
      return 1;
    }
    io.log(`installed ${binary}`);
  }
  try {
    await ensureChrome(binary, { withDeps: options.withDeps === true, log: io.log });
  } catch (error) {
    io.error(`Chrome is not ready: ${message(error)}`);
    if (process.platform === "linux" && !options.withDeps) io.error("on Linux, install Chrome's system libraries with `sudo openmausbot browser install --with-deps`, then retry `openmausbot browser install` as the user running serve");
    return 1;
  }
  io.log("browser installed for this user and data directory; run serve as the same user, then enable it under Settings → Experimental and per bot");
  if (process.platform === "linux" && options.withDeps) io.log("if serve runs as another user, run `openmausbot browser install` from that user's login shell too");
  return 0;
}
