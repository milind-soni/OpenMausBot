// The browsers a person may import a sign-in from, where each keeps its profiles, and the key that opens a Chromium
// profile's cookies. Nothing here reads a cookie: listing reads only `Local State` and `profiles.ini`.
//
// The browser table, the profile discovery and the key lookups follow anomalyco/opencode@5ca87b9
// packages/gui-plugins/src/browser/profile/sources.ts (definitions, localStateProfiles, chromiumKey, unprotect, run),
// MIT License, Copyright (c) 2025 opencode (full text in third_party/opencode/LICENSE). Modified: the file system, the
// platform and the key store are passed in, and the table keeps the browsers this app names.
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { deriveCbcKey, type ChromiumKey } from "./readers.ts";

export type Engine = "chromium" | "firefox" | "safari";

export interface BrowserSource {
  id: string;
  name: string;
  engine: Engine;
  profiles: Array<{ id: string; name: string }>;
}

/** What the importer may read of this computer. Tests pass a folder of fixtures; the app passes the real home. */
export interface BrowserFiles {
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
}

/**
 * The operating system's store of each Chromium browser's cookie key. Every method may show the person a system
 * prompt, so it is called only after they confirmed an import. Tests pass a fake: a real call raises a Keychain prompt.
 */
export interface KeyStore {
  /** macOS: the browser's Safe Storage password from the login Keychain. Rejects when the person denies it. */
  macPassword(service: string, account: string): Promise<string>;
  /** Windows: a DPAPI blob unwrapped for the current user. */
  windowsUnprotect(blob: Buffer): Promise<Buffer>;
  /** Linux: the keyring's Safe Storage password for an `application` attribute, or null when it holds none. */
  linuxPassword(application: string): Promise<string | null>;
}

interface Definition {
  id: string;
  name: string;
  engine: Engine;
  root: string;
  keychain?: { service: string; account: string };
  keyring?: string[];
  /** The user data folder is the profile itself, as in Opera. */
  flat?: boolean;
}

function definitions(files: BrowserFiles): Definition[] {
  const { home, env, platform } = files;
  if (platform === "win32") {
    const join = win32.join;
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roaming = env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      chromium("chrome", "Google Chrome", join(local, "Google", "Chrome", "User Data")),
      chromium("edge", "Microsoft Edge", join(local, "Microsoft", "Edge", "User Data")),
      chromium("brave", "Brave", join(local, "BraveSoftware", "Brave-Browser", "User Data")),
      chromium("arc", "Arc", join(local, "Packages", "TheBrowserCompany.Arc_ttt1ap7aakyb4", "LocalCache", "Local", "Arc", "User Data")),
      chromium("vivaldi", "Vivaldi", join(local, "Vivaldi", "User Data")),
      { ...chromium("opera", "Opera", join(roaming, "Opera Software", "Opera Stable")), flat: true },
      chromium("chromium", "Chromium", join(local, "Chromium", "User Data")),
      firefox("firefox", "Firefox", join(roaming, "Mozilla", "Firefox")),
    ];
  }
  const join = posix.join;
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    const keychain = (account: string) => ({ keychain: { service: `${account} Safe Storage`, account } });
    return [
      { ...chromium("chrome", "Google Chrome", join(support, "Google", "Chrome")), ...keychain("Chrome") },
      { ...chromium("edge", "Microsoft Edge", join(support, "Microsoft Edge")), ...keychain("Microsoft Edge") },
      { ...chromium("brave", "Brave", join(support, "BraveSoftware", "Brave-Browser")), ...keychain("Brave") },
      { ...chromium("arc", "Arc", join(support, "Arc", "User Data")), ...keychain("Arc") },
      { ...chromium("vivaldi", "Vivaldi", join(support, "Vivaldi")), ...keychain("Vivaldi") },
      { ...chromium("opera", "Opera", join(support, "com.operasoftware.Opera")), ...keychain("Opera"), flat: true },
      { ...chromium("chromium", "Chromium", join(support, "Chromium")), ...keychain("Chromium") },
      { id: "safari", name: "Safari", engine: "safari", root: join(home, "Library") },
      firefox("firefox", "Firefox", join(support, "Firefox")),
    ];
  }
  const config = env.XDG_CONFIG_HOME ?? join(home, ".config");
  const keyring = (...names: string[]) => ({ keyring: names });
  return [
    { ...chromium("chrome", "Google Chrome", join(config, "google-chrome")), ...keyring("chrome") },
    { ...chromium("edge", "Microsoft Edge", join(config, "microsoft-edge")), ...keyring("chromium") },
    { ...chromium("brave", "Brave", join(config, "BraveSoftware", "Brave-Browser")), ...keyring("brave") },
    { ...chromium("vivaldi", "Vivaldi", join(config, "vivaldi")), ...keyring("vivaldi", "chrome") },
    { ...chromium("opera", "Opera", join(config, "opera")), ...keyring("chromium"), flat: true },
    { ...chromium("chromium", "Chromium", join(config, "chromium")), ...keyring("chromium") },
    firefox("firefox", "Firefox", join(home, ".mozilla", "firefox")),
    firefox("firefox-snap", "Firefox (Snap)", join(home, "snap", "firefox", "common", ".mozilla", "firefox")),
  ];
}

const chromium = (id: string, name: string, root: string): Definition => ({ id, name, engine: "chromium", root });
const firefox = (id: string, name: string, root: string): Definition => ({ id, name, engine: "firefox", root });

const pathOf = (files: BrowserFiles) => (files.platform === "win32" ? win32 : posix);

/** A profile folder named by a file: one plain folder name, nothing that climbs out of the browser's own folder. */
const PLAIN = /^[^/\\:]{1,128}$/u;

async function localState(files: BrowserFiles, root: string): Promise<{ profile?: { info_cache?: Record<string, { name?: unknown }> }; os_crypt?: { encrypted_key?: unknown } } | null> {
  const text = await files.readText(pathOf(files).join(root, "Local State"));
  if (text === null) return null;
  // Security: the parser's message can quote the file, which holds the wrapped key.
  try { return JSON.parse(text) as never; } catch { return null; }
}

export interface Located {
  source: Definition;
  profile: { id: string; name: string; directory: string; cookies: string };
}

async function chromiumProfiles(files: BrowserFiles, source: Definition): Promise<Located["profile"][]> {
  const join = pathOf(files).join;
  const cookies = async (directory: string) => {
    for (const candidate of [join(directory, "Network", "Cookies"), join(directory, "Cookies")]) if (await files.exists(candidate)) return candidate;
    return null;
  };
  if (source.flat) {
    const file = await cookies(source.root);
    return file ? [{ id: "default", name: "Default", directory: source.root, cookies: file }] : [];
  }
  const state = await localState(files, source.root);
  const names = new Map<string, string>();
  for (const [id, info] of Object.entries(state?.profile?.info_cache ?? {})) {
    if (PLAIN.test(id) && id !== "." && id !== "..") names.set(id, typeof info?.name === "string" && info.name ? info.name.slice(0, 80) : id);
  }
  if (!names.has("Default")) names.set("Default", "Default");
  const found: Located["profile"][] = [];
  for (const [id, name] of names) {
    const directory = join(source.root, id);
    const file = await cookies(directory);
    if (file) found.push({ id, name, directory, cookies: file });
  }
  return found;
}

/** The profiles a Firefox `profiles.ini` lists, with their folders resolved. */
export function firefoxProfiles(root: string, ini: string, join: (...parts: string[]) => string = posix.join): Array<{ id: string; name: string; directory: string }> {
  return ini.split(/^\[/mu).flatMap((section) => {
    if (!section.slice(0, section.indexOf("]")).startsWith("Profile")) return [];
    const fields = Object.fromEntries(section.split(/\r?\n/u).slice(1).flatMap((line) => {
      const index = line.indexOf("=");
      return index > 0 ? [[line.slice(0, index).trim(), line.slice(index + 1).trim()]] : [];
    }));
    const value = fields.Path;
    if (!value || value.length > 512) return [];
    if (fields.IsRelative !== "0" && (value.split(/[/\\]/u).includes(".."))) return [];
    return [{ id: value, name: (fields.Name || value).slice(0, 80), directory: fields.IsRelative === "0" ? value : join(root, value) }];
  });
}

async function profilesOf(files: BrowserFiles, source: Definition): Promise<Located["profile"][]> {
  const join = pathOf(files).join;
  if (source.engine === "safari") {
    // Listed without looking inside Safari's container: a look there can raise a system prompt before the person asked.
    return [{ id: "default", name: "Default", directory: source.root, cookies: join(source.root, "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies") }];
  }
  if (source.engine === "firefox") {
    const ini = await files.readText(join(source.root, "profiles.ini"));
    if (ini === null) return [];
    const found: Located["profile"][] = [];
    for (const profile of firefoxProfiles(source.root, ini, join)) {
      const cookies = join(profile.directory, "cookies.sqlite");
      if (await files.exists(cookies)) found.push({ ...profile, cookies });
    }
    return found;
  }
  return chromiumProfiles(files, source);
}

/** Every browser with at least one profile, for the person to pick from. Safari is offered on macOS whenever installed. */
export async function listSources(files: BrowserFiles): Promise<BrowserSource[]> {
  const sources: BrowserSource[] = [];
  for (const source of definitions(files)) {
    if (source.engine === "safari" && !(await files.exists("/Applications/Safari.app"))) continue;
    const profiles = await profilesOf(files, source);
    if (profiles.length) sources.push({ id: source.id, name: source.name, engine: source.engine, profiles: profiles.map(({ id, name }) => ({ id, name })) });
  }
  return sources;
}

/** A profile the listing offered, by its ids: nothing a caller sends is ever used as a path. */
export async function locate(files: BrowserFiles, sourceId: string, profileId: string): Promise<Located | null> {
  const source = definitions(files).find((candidate) => candidate.id === sourceId);
  const profile = source ? (await profilesOf(files, source)).find((candidate) => candidate.id === profileId) : undefined;
  return source && profile ? { source, profile } : null;
}

/** Windows Chrome-family browsers whose `Local State` carries no DPAPI key: their values cannot be read here. */
export class KeyUnavailable extends Error {}

/** The key of a Chromium source, asked of the key store only now. */
export async function chromiumKey(files: BrowserFiles, located: Located, keys: KeyStore): Promise<ChromiumKey> {
  const source = located.source;
  if (files.platform === "win32") {
    const wrapped = (await localState(files, source.root))?.os_crypt?.encrypted_key;
    const blob = typeof wrapped === "string" ? Buffer.from(wrapped, "base64") : null;
    if (!blob || blob.subarray(0, 5).toString("latin1") !== "DPAPI") throw new KeyUnavailable("This browser keeps no key this app can use.");
    return { type: "gcm", key: await keys.windowsUnprotect(blob.subarray(5)) };
  }
  if (files.platform === "darwin") {
    if (!source.keychain) throw new KeyUnavailable("This browser keeps no key this app can use.");
    const password = await keys.macPassword(source.keychain.service, source.keychain.account);
    return { type: "cbc", v10: deriveCbcKey(password.replace(/\r?\n$/u, ""), 1003), v11: null };
  }
  let keyring: string | null = null;
  for (const application of source.keyring ?? []) {
    keyring = await keys.linuxPassword(application).catch(() => null);
    if (keyring) break;
  }
  // v10 values use Chromium's fixed password; v11 the one the desktop keyring holds.
  return { type: "cbc", v10: deriveCbcKey("peanuts", 1), v11: keyring ? deriveCbcKey(keyring, 1) : null };
}

export type Run = (command: string, args: readonly string[], input?: string) => Promise<string>;

/**
 * A helper program by its absolute path, without a shell and in its own folder, so neither PATH nor the working folder
 * can put another program in its place; 60 seconds. Security: its output (a key) is returned, never logged, and an
 * error names only the program and its exit code.
 */
export const runProgram: Run = (command, args, input) => new Promise((resolve, reject) => {
  if (!posix.isAbsolute(command) && !win32.isAbsolute(command)) {
    reject(new Error(`${command} is not an absolute path`));
    return;
  }
  const child = spawn(command, args, { cwd: (command.includes("\\") ? win32 : posix).dirname(command), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => child.kill(), 60_000);
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stdin.on("error", () => undefined);
  child.on("error", () => { clearTimeout(timer); reject(new Error(`${command} could not start`)); });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
    else reject(new Error(`${command} exited with ${code}`));
  });
  child.stdin.end(input ?? "");
});

/** Windows PowerShell in the system folder; `SystemRoot` only when it is an absolute drive path. */
function windowsPowerShell(env: BrowserFiles["env"]): string {
  const root = env.SystemRoot;
  const system = root && /^[A-Za-z]:\\[^"<>|?*]*$/u.test(root) ? root : "C:\\Windows";
  return win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The operating system's key stores, through their own command-line tools. Known open risk: macOS's Keychain prompt
 * names `security`, not this app, and "Always Allow" there lets later reads by any process through `security` go silent.
 */
export function systemKeyStore(env: BrowserFiles["env"], run: Run = runProgram): KeyStore {
  return {
    macPassword: (service, account) => run("/usr/bin/security", ["find-generic-password", "-w", "-a", account, "-s", service]),
    async windowsUnprotect(blob) {
      const script = "Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());"
        + "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
      const output = await run(windowsPowerShell(env), ["-NoProfile", "-NonInteractive", "-Command", script], blob.toString("base64"));
      return Buffer.from(output.trim(), "base64");
    },
    async linuxPassword(application) {
      for (const tool of ["/usr/bin/secret-tool", "/bin/secret-tool"]) {
        const value = await run(tool, ["lookup", "application", application]).then((text) => text.replace(/\r?\n$/u, ""), () => null);
        if (value) return value;
      }
      return null;
    },
  };
}

/** Live tests set it to a fixture profile's Safe Storage password; the packaged app never passes it to its server. */
export const TEST_COOKIE_KEY_ENV = "OMB_TEST_COOKIE_KEY";

/**
 * The key store an import uses: the system's, or, for a live test of a fixture profile, one that answers every
 * Chromium browser's password with `OMB_TEST_COOKIE_KEY` and never reaches the Keychain, DPAPI or a keyring.
 */
export function keyStoreFor(env: BrowserFiles["env"], run: Run = runProgram): KeyStore {
  const fixture = env[TEST_COOKIE_KEY_ENV];
  if (fixture === undefined || fixture === "") return systemKeyStore(env, run);
  return {
    macPassword: async () => fixture,
    windowsUnprotect: async () => { throw new Error("A test key store unwraps no DPAPI blob."); },
    linuxPassword: async () => fixture,
  };
}

/** This computer as the person's own account sees it: only ever read once the person asked for an import. */
export function systemFiles(): BrowserFiles {
  return {
    platform: process.platform,
    home: (process.platform !== "win32" && process.env.HOME) || homedir(),
    env: process.env,
    readText: (path) => readFile(path, "utf8").catch(() => null),
    exists: (path) => access(path).then(() => true, () => false),
  };
}
