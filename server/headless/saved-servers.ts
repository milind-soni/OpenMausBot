// The servers `openmausbot login` signed in to, like kubectl's contexts: servers.json names each server and which one is
// current; the session itself is in the macOS Keychain, or in a file only this user can read elsewhere. Nothing here is
// ever printed. Paths come from the environment the command runs with, never from the process's own home.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HeadlessError, EXIT } from "./args.ts";
import { inBotShell } from "./bot-shell.ts";

export interface SavedServer {
  url: string;
  environmentId: string;
  label: string;
  sessionId: string;
  scopes: string[];
  expiresAt: number;
  store: "keychain" | "file";
}

interface SavedFile {
  current?: string;
  servers: Record<string, SavedServer>;
}

/** Runs macOS `security` with `stdin` as its input; tests pass a fake so no real keychain is touched. */
export type SecurityRunner = (args: readonly string[], stdin?: string) => { status: number | null; stdout: string };

export interface SavedServersOptions {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  security?: SecurityRunner;
}

const KEYCHAIN_SERVICE = "openmausbot-cli";
const NAME = /^[\w.-]{1,80}$/;

const runSecurity: SecurityRunner = (args, stdin) => {
  const result = spawnSync("/usr/bin/security", [...args], { input: stdin, encoding: "utf8", timeout: 15_000 });
  return { status: result.status, stdout: result.stdout ?? "" };
};

export function cliConfigDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  if (env.XDG_CONFIG_HOME?.trim()) return join(env.XDG_CONFIG_HOME.trim(), "openmausbot");
  if (platform === "win32" && env.APPDATA?.trim()) return join(env.APPDATA.trim(), "openmausbot");
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  return home ? join(home, ".config", "openmausbot") : null;
}

/** `security -i` reads its command from stdin, so the session never appears in a process list. */
const quoted = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

export class SavedServers {
  readonly dir: string | null;
  private readonly platform: NodeJS.Platform;
  private readonly security: SecurityRunner;

  constructor(options: SavedServersOptions) {
    this.platform = options.platform ?? process.platform;
    this.dir = cliConfigDir(options.env, this.platform);
    this.security = options.security ?? runSecurity;
  }

  private get file(): string | null {
    return this.dir ? join(this.dir, "servers.json") : null;
  }

  private read(): SavedFile {
    const file = this.file;
    if (!file || !existsSync(file)) return { servers: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as SavedFile;
      return { ...(typeof parsed.current === "string" ? { current: parsed.current } : {}), servers: parsed.servers && typeof parsed.servers === "object" ? parsed.servers : {} };
    } catch {
      throw new HeadlessError(`${file} could not be read`, EXIT.failed, "fix or remove it, then run openmausbot login again");
    }
  }

  private write(saved: SavedFile): void {
    const file = this.file;
    if (!file || !this.dir) throw new HeadlessError("no home folder to keep the sign-in in", EXIT.failed, "set HOME");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    if (this.platform !== "win32") chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  }

  list(): { current: string | null; servers: Array<SavedServer & { name: string }> } {
    const saved = this.read();
    return { current: saved.current ?? null, servers: Object.entries(saved.servers).map(([name, server]) => ({ name, ...server })) };
  }

  get(name: string): SavedServer | null {
    return this.read().servers[name] ?? null;
  }

  current(): (SavedServer & { name: string }) | null {
    const saved = this.read();
    const server = saved.current ? saved.servers[saved.current] : undefined;
    return server && saved.current ? { name: saved.current, ...server } : null;
  }

  /** The saved server at exactly this origin, so a session goes only where it was made. */
  at(origin: string): (SavedServer & { name: string }) | null {
    return this.list().servers.find((server) => server.url === origin) ?? null;
  }

  use(name: string): void {
    const saved = this.read();
    if (!saved.servers[name]) throw new HeadlessError(`no saved server named "${name}"`, EXIT.notFound, "openmausbot servers lists them");
    this.write({ ...saved, current: name });
  }

  /** Keeps the session and makes this server current; says where the session went. */
  save(name: string, server: Omit<SavedServer, "store">, token: string): SavedServer["store"] {
    if (!NAME.test(name)) throw new HeadlessError(`"${name}" is not a usable name: letters, digits, dots and dashes`, EXIT.usage);
    const store = this.putToken(name, token);
    const saved = this.read();
    this.write({ current: name, servers: { ...saved.servers, [name]: { ...server, store } } });
    return store;
  }

  forget(name: string): void {
    const saved = this.read();
    const server = saved.servers[name];
    if (!server) return;
    this.removeToken(name, server.store);
    const { [name]: _gone, ...rest } = saved.servers;
    this.write({ ...(saved.current && saved.current !== name ? { current: saved.current } : {}), servers: rest });
  }

  token(name: string): string | null {
    const server = this.get(name);
    if (!server) return null;
    if (server.store === "keychain") {
      const found = this.security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
      return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : null;
    }
    const file = this.tokenFile(name);
    try {
      return readFileSync(file, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  private tokenFile(name: string): string {
    return join(this.dir!, "sessions", name);
  }

  private putToken(name: string, token: string): SavedServer["store"] {
    if (this.platform === "darwin") {
      const added = this.security(["-i"], `add-generic-password -U -s ${quoted(KEYCHAIN_SERVICE)} -a ${quoted(name)} -l ${quoted(`OpenMausBot CLI: ${name}`)} -w ${quoted(token)}\n`);
      if (added.status === 0) return "keychain";
    }
    if (!this.dir) throw new HeadlessError("no home folder to keep the sign-in in", EXIT.failed, "set HOME");
    mkdirSync(join(this.dir, "sessions"), { recursive: true, mode: 0o700 });
    const file = this.tokenFile(name);
    rmSync(file, { force: true });
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
    if (this.platform !== "win32") chmodSync(file, 0o600);
    return "file";
  }

  private removeToken(name: string, store: SavedServer["store"]): void {
    if (store === "keychain") this.security(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]);
    else if (this.dir) rmSync(this.tokenFile(name), { force: true });
  }
}

const classicHeaders = new Map<string, Promise<Record<string, string>>>();

/** For the classic commands (pair, devices): the saved sign-in for exactly this origin, while the server there is still
 * the one it was made for; never in a bot's shell. */
export function savedSessionHeaders(origin: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  if (inBotShell(env)) return Promise.resolve({});
  const known = classicHeaders.get(origin);
  if (known) return known;
  const looked = (async (): Promise<Record<string, string>> => {
    const saved = new SavedServers({ env });
    const server = saved.at(origin);
    if (!server) return {};
    const live = await fetch(`${origin}/.well-known/openmausbot/environment`, { signal: AbortSignal.timeout(3_000) })
      .then((response) => response.json() as Promise<{ environmentId?: unknown }>, () => null);
    const token = live?.environmentId === server.environmentId ? saved.token(server.name) : null;
    return token ? { authorization: `Bearer ${token}` } : {};
  })().catch(() => ({}));
  classicHeaders.set(origin, looked);
  return looked;
}
