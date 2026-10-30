// This computer's server, started as the desktop app starts it (its private port emulated over Node's IPC), and servers of
// the person's own (`openmausbot serve`, nothing of MausBot Cloud), each paired with this app as a pairing link pairs it.
// Main's own wiring for the move to such a server (electron/own-home-main.mjs) sits between them, its requests carrying
// the pairing's session as the window's would. Disposable homes and a synthetic Claude CLI; no network.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLoginHandoffClient } from "../../electron/cloud-logins.mjs";
import { installOwnHome } from "../../electron/own-home-main.mjs";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { freePortBlock } from "../../server/testing/ports.ts";

const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));
const parse = (text: string) => { try { return JSON.parse(text); } catch { return null; } };
type Answer = { status: number; body: any };
type Side = (method: string, path: string, body?: unknown) => Promise<Answer>;

export interface OwnServer {
  name: string;
  base: string;
  dataDir: string;
  /** This app's sign-in there: a pairing's session, as the window holds it. */
  token: string;
  /** A request as that sign-in. */
  as: Side;
  /** The saved place this app keeps for it (environments.cjs). */
  place: { id: string; kind: "remote"; name: string; origin: string };
}

export interface OwnHomeFixture {
  root: string;
  desktopBase: string;
  desktopDataDir: string;
  local: Side;
  /** A server of the person's own, added and paired; `env`: more of its environment (a sign-in list, say). */
  addServer(name: string, env?: NodeJS.ProcessEnv): Promise<OwnServer>;
  /** Main's move to a server of the person's own, as the app that is open now runs it. */
  main: ReturnType<typeof installOwnHome>;
  /** Its journal, and a look at each write before it lands: throwing there is the app killed. */
  journalFile: string;
  beforeJournalWrite: ((value: any) => void) | null;
  /** What main asked for besides: the project folders lent with the place, the phone link, and the place opened. */
  spies: { lent: Array<{ projects: string[]; place: string | null }>; phoneStops: number; opened: string[] };
  /** The app quits or is killed: its main wiring stops, this computer's server is killed, and both start again. */
  relaunch(options?: { kill?: boolean }): Promise<void>;
  /** The fetch main's requests go through: the saved places' sign-ins, as the window's session carries them. */
  windowFetch: typeof fetch;
  logs(): string;
  close(): Promise<void>;
}

export async function launchOwnHomeFixture({ env = {} }: { env?: NodeJS.ProcessEnv } = {}): Promise<OwnHomeFixture> {
  const root = mkdtempSync(join(tmpdir(), "omb-own-home-"));
  const children = new Set<ChildProcess>();
  let logs = "";

  async function start(name: string, own: NodeJS.ProcessEnv, port: number, extra: string[] = [], ipc = false): Promise<ChildProcess> {
    const home = join(root, name);
    const dataDir = join(home, ".openmausbot");
    mkdirSync(dataDir, { recursive: true });
    const cli = join(home, "fixture-claude.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
process.env.FAKE_CLAUDE_FIXTURE_DIR = ${JSON.stringify(home)};
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
    try { readFileSync(join(dataDir, "config.json")); } catch {
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
        ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
        claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
      } }));
    }
    const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
    const child = spawn(process.execPath, ["--import", offline, ...extra, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), ...env, ...own },
      stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc" as const] : [])],
    });
    children.add(child);
    child.on("close", () => children.delete(child));
    child.stdout?.on("data", (chunk) => { logs += chunk; });
    child.stderr?.on("data", (chunk) => { logs += chunk; });
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`${name} exited:\n${logs}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return child; } catch {}
      if (Date.now() > deadline) throw new Error(`${name} did not start:\n${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const parentPort = `data:text/javascript,${encodeURIComponent(`
    const listeners = [];
    Object.defineProperty(process, "parentPort", { value: {
      on(event, listener) { if (event === "message") listeners.push(listener); },
      postMessage(message) { process.send?.(message); },
    } });
    process.on("message", (data) => { for (const listener of listeners) listener({ data }); });
    process.channel?.unref();
  `)}`;
  const capability = randomBytes(32).toString("base64url");
  const desktopPort = await freePortBlock([0, 1]);
  const desktopBase = `http://127.0.0.1:${desktopPort}`;
  const startDesktop = async () => {
    const child = await start("desktop", { OMB_DESKTOP_PARENT: "1", OMB_ENVIRONMENT_LABEL: "Work laptop" }, desktopPort, ["--import", parentPort], true);
    child.send({ type: "openmausbot:desktop-mutation-token", token: capability });
    return child;
  };
  let desktop = await startDesktop();
  const local: Side = async (method, path, body) => {
    const response = await fetch(`${desktopBase}${path}`, { method, headers: { "x-openmausbot-desktop-owner": capability, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: parse(await response.text()) };
  };
  const ready = async () => { for (let tries = 0; (await local("GET", "/api/bots")).status !== 200 && tries < 50; tries++) await new Promise((resolve) => setTimeout(resolve, 100)); };
  await ready();

  const servers: OwnServer[] = [];
  /** The window's own requests: each saved place's sign-in goes only to that place. */
  const windowFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const server = servers.find((candidate) => String(url).startsWith(`${candidate.base}/`));
    const headers = { ...(init.headers as Record<string, string>), ...(server ? { authorization: `Bearer ${server.token}` } : {}) };
    return fetch(url, { ...init, headers });
  }) as typeof fetch;

  async function addServer(name: string, more: NodeJS.ProcessEnv = {}): Promise<OwnServer> {
    const port = await freePortBlock([0, 1]);
    const base = `http://127.0.0.1:${port}`;
    await start(`server-${servers.length + 1}`, { OMB_ENVIRONMENT_LABEL: name, ...more }, port);
    // `openmausbot pair` on that server, then the link opened in this app: a session of the admin scope.
    const minted = await fetch(`${base}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "My desktop" }) });
    const code = (await minted.json() as { code: string }).code;
    const paired = await fetch(`${base}/api/auth/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, label: "OpenMausBot app" }) });
    const token = (await paired.json() as { token: string }).token;
    if (typeof token !== "string") throw new Error(`could not pair with ${name}`);
    const as: Side = async (method, path, body) => {
      const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: parse(await response.text()) };
    };
    const server: OwnServer = { name, base, dataDir: join(root, `server-${servers.length + 1}`, ".openmausbot"), token, as,
      place: { id: `place-${servers.length + 1}`, kind: "remote", name, origin: base } };
    servers.push(server);
    return server;
  }

  const journalFile = join(root, "own-home.json");
  const file = (name: string) => ({
    read: () => JSON.parse(readFileSync(join(root, name), "utf8")),
    write: (value: unknown) => { if (name === "own-home.json") fixture.beforeJournalWrite?.(value); writeFileSync(join(root, `${name}.tmp`), JSON.stringify(value ?? null)); renameSync(join(root, `${name}.tmp`), join(root, name)); },
  });
  const fixture = { beforeJournalWrite: null as OwnHomeFixture["beforeJournalWrite"] };
  const spies: OwnHomeFixture["spies"] = { lent: [], phoneStops: 0, opened: [] };
  const asks = createLoginHandoffClient();
  const port = { postMessage: (message: unknown) => { desktop.send(message as object); } };
  const wire = () => installOwnHome({
    localRequest: (route, init = {}) => fetch(`${desktopBase}${route}`, { ...init, headers: { ...init.headers as Record<string, string>, "x-openmausbot-desktop-owner": capability } }),
    fetch: windowFetch,
    environments: () => servers.map((server) => server.place),
    handoff: (what) => asks.request(port, what as never),
    journal: file("own-home.json"),
    choice: file("own-home-choice.json"),
    sendState: file("own-home-send.json"),
    cloudJournal: () => null,
    lend: async (projects, place) => { spies.lent.push({ projects, place: place?.origin ?? null }); },
    phone: { paired: () => true, stop: async () => { spies.phoneStops++; }, start: async () => {} },
    openHome: (place) => { spies.opened.push(place.origin ?? ""); },
    lastInput: () => 0,
    version: "0.1.135",
    log: (line) => { logs += `[main] ${line}\n`; },
  });
  let main = wire();
  const listen = () => { desktop.on("message", (message) => { asks.receive(port, message); }); };
  listen();

  return {
    root, desktopBase, desktopDataDir: join(root, "desktop", ".openmausbot"), local, addServer, journalFile, spies, windowFetch, logs: () => logs,
    get main() { return main; },
    get beforeJournalWrite() { return fixture.beforeJournalWrite; },
    set beforeJournalWrite(hook) { fixture.beforeJournalWrite = hook; },
    async relaunch({ kill = true } = {}) {
      main.close();
      await waitForExit(desktop, { signal: kill ? "SIGKILL" : "SIGTERM" });
      desktop = await startDesktop();
      await ready();
      main = wire();
      listen();
    },
    async close() {
      main.close();
      for (const child of children) await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(root);
    },
  };
}
