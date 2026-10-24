// Two real servers for Send to My Cloud: this computer's, started as the desktop app starts it (its private
// utility-process port emulated over Node's IPC, the owner's capability delivered through it), and the person's Cloud
// home, paired the way the Admin pairs it. Main's own wiring (electron/one-home-main.mjs, which installs
// cloud-send-main.mjs) sits between them with a fake ipcMain and a fake MausBot Cloud sign-in. Either server can be
// killed and started again on its own data, as an app that quits or crashes is. Disposable homes, a synthetic Claude CLI
// and a fake 1Password SDK; no network.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLoginHandoffClient, type ConnectionAsk } from "../../electron/cloud-logins.mjs";
import { createCloudSend, type CloudMoveCheck, type CloudSendOutcome, type CloudSendSnapshot } from "../../electron/cloud-send.mjs";
import { openOwnerSession } from "../../electron/cloud-send-main.mjs";
import { BACKGROUND_HEADERS } from "../../electron/cloud-power.mjs";
import { installOneHome } from "../../electron/one-home-main.mjs";
import type { OneHomeView } from "../../electron/one-home.mjs";
import { cloudPairingSignature, cloudRequestSignature } from "../../server/cloud-home.ts";
import type { TeamMember } from "../../server/cloud-team.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { freePortBlock } from "../../server/testing/ports.ts";

const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));
export const CLOUD_HOST = "omb-t-5e6d7c8b9a0f.fly.dev";
const EDGE = { host: CLOUD_HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${CLOUD_HOST}` };
const parse = (text: string) => { try { return JSON.parse(text); } catch { return null; } };

export interface CloudSendFixture {
  root: string;
  desktopBase: string;
  cloudBase: string;
  /** The owner's own device on My Cloud, through the edge: what the window's Cloud session is. */
  owner: string;
  ownerCapability: string;
  edge: typeof EDGE;
  /** Every answer either server gave, for the no-secret check. */
  answers: string[];
  logs(): string;
  local(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  onCloud(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** A picture on this computer's server, as an avatarUrl. */
  picture(bytes: Uint8Array): Promise<string>;
  /** Main's IPC handlers, as this computer's page (or My Cloud's, with page "cloud") calls them. */
  call<T>(channel: string, page: "local" | "cloud", ...args: unknown[]): Promise<T>;
  /** The labels of the sessions each send made on My Cloud, as main asked for them. */
  labels: string[];
  /** The Admin's one-time code for this Cloud, as pairHome() gives it. */
  grant(label: string): Promise<{ origin: string; code: string; expiresAt: number }>;
  /** What an older desktop's Send everything did, over the same cloud-send.json: the app is then opened again, as an
   * update after it would. */
  olderSend(input?: { keys?: string[]; force?: string[] }): Promise<CloudSendOutcome>;
  /** An older desktop's comparison of both sides. */
  olderCompare(): Promise<CloudSendSnapshot>;
  /** A pass of the one-time move, through main's own wiring; `final`: the one after this computer stopped. */
  move(options?: { final?: boolean }): Promise<CloudSendOutcome>;
  /** The move's check of what arrived, through main's own wiring. */
  check(): Promise<CloudMoveCheck>;
  /** The labels of the sessions each send made, and whether each counted as someone using My Cloud. */
  sessions: Array<{ label: string; background: boolean }>;
  /** Each request main sent My Cloud's chats route: the rows of each conversation it carried. */
  chatRequests: Array<Array<{ threadId: string; rows: number }>>;
  /** With `broker`: this computer's installation on the connected-apps service. */
  desktopInstallation: { id: string; token: string; userId: string } | null;
  /** This computer's server's private port, asked as main asks it (cloud-logins.mjs). */
  handoff(what: ConnectionAsk): Promise<any>;
  /** The one-time move (one-home.mjs), as main runs it in the app that is open now. */
  oneHome: { kick(): Promise<void>; view(): OneHomeView | null; away(): boolean };
  /** The MausBot Cloud sign-in main reads: the Admin's word on this account's Cloud, its export of a held one, the Admin
   * taking a computer's word that its move is done (when a test sets it), and the Admin's team pairing for one of the
   * account's teams (`state.teams`). */
  account: CloudSendAccount;
  /** A bot moving from My Cloud into a team, as main runs it (team-move-main.mjs). */
  teamMove: { start(input: { bot: { id: string; name: string }; team: { id: string; name: string; origin?: string } }): Promise<void>; kick(): Promise<void>; view(): any; retry(): Promise<void>; seen(): any; journal(): any };
  /** The team moves' journal, and a look at each write before it lands: throwing there is the app killed. */
  teamJournalFile: string;
  beforeTeamJournalWrite: ((value: any) => void) | null;
  /** Its journal (userData/one-home.json), and a look at each write before it lands: throwing there is the app killed. */
  journalFile: string;
  beforeJournalWrite: ((value: any) => void) | null;
  /** An answer of its own for a request main sends My Cloud, in place of My Cloud's: a network that fails, say. */
  intercept: ((url: string, init: RequestInit) => Response | null) | null;
  /** What main asked for besides: lending, the phone link, which home the window opened, and an app relaunch. */
  spies: { lent: string[][]; phoneStops: number; phoneStarts: number; opened: string[]; relaunches: number };
  /** The app quits or is killed: its main wiring stops, this computer's server is killed, and both start again on the
   * same data. With `cloud`, My Cloud's server is started again too, with more of its environment. */
  relaunch(options?: { kill?: boolean; cloud?: NodeJS.ProcessEnv }): Promise<void>;
  /** The Team Cloud started with `team` (docs/team-cloud.md), paired the way the Admin pairs it: a signed body with
   * the member claim, redeemed at /api/auth/pair. Null without `team`. */
  team: CloudTeamFixture | null;
  /** Another computer of the same person, with its own server, app and MausBot Cloud sign-in, that can move to the same
   * My Cloud. `label`: its name (OMB_ENVIRONMENT_LABEL). */
  addDesk(options: { label: string }): Promise<CloudSendDesk>;
  close(): Promise<void>;
}

export interface CloudSendAccount {
  state: Record<string, any>;
  exportHome(options?: { installation?: string }): Promise<any>;
  reportMove?(options: { installation: string }): Promise<boolean>;
  /** The Admin taking a computer's word that it keeps its bots on itself again, when a test sets it. */
  reportKept?(options: { installation: string }): Promise<boolean>;
  pairTeam(teamId: string): Promise<{ origin: string; code: string; expiresAt: number }>;
}

/** One more of the person's computers (CloudSendFixture `addDesk`): what the fixture has for its own, for this one. */
export interface CloudSendDesk {
  base: string;
  dataDir: string;
  local(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  oneHome: { kick(): Promise<void>; view(): OneHomeView | null; away(): boolean };
  account: CloudSendAccount;
  journalFile: string;
  spies: { lent: string[][]; phoneStops: number; phoneStarts: number; opened: string[]; relaunches: number };
  /** The app quits or is killed, and opens again; its server too, on the same data. */
  relaunch(options?: { kill?: boolean }): Promise<void>;
}

export interface CloudTeamFixture {
  base: string;
  home: string;
  id: string;
  name: string;
  /** The Admin's signed pairing for one member, as the Admin hands it to the app: a one-time code, not redeemed. */
  grant(member: TeamMember): Promise<{ origin: string; code: string; expiresAt: number }>;
  /** The Admin's signed pairing for one member, redeemed into a bearer. `body` replaces the member and team claims
   * (a forged or missing claim); `secret` signs with another key (a forgery). */
  pair(member: TeamMember | null, options?: { body?: Record<string, unknown>; secret?: string; label?: string }): Promise<{ status: number; body: any; token: string | null }>;
  /** A request as one person, by their bearer. */
  as(token: string, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  /** The Admin's signed power request (the sleep handshake). */
  signed(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** A turn's own bearer for the internal routes, as the harness gives a bot's tools. */
  capability(botId: string, threadId: string): Promise<string>;
  /** The server stopped and started again on the same data (a deploy). */
  relaunch(env?: NodeJS.ProcessEnv): Promise<void>;
}

function fakeOnePassword(at: string, token: string): string {
  const sdk = join(at, "node_modules", "@1password", "sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@1password/sdk", version: "0.5.0", main: "index.js" }));
  writeFileSync(join(sdk, "index.js"), `"use strict";
exports.createClient = async ({ auth }) => {
  if (auth !== ${JSON.stringify(token)}) throw new Error("error authenticating: invalid service account token");
  return {
    vaults: { list: async () => [{ id: "v1", title: "Shared with OpenMausBot" }] },
    items: { list: async () => [], getAll: async () => ({ individualResponses: [] }) },
  };
};
`);
  return at;
}

/** `cloudOnePasswordToken`: the token My Cloud's 1Password accepts (default: this computer's), so a test can make 1Password
 * refuse this computer's token on My Cloud. `toolCalls`: each turn on this computer makes that many tool calls first, so a
 * few turns make a conversation of several pages. `broker`: the connected-apps service both servers use, this computer
 * with an installation of its own as the desktop app registers one, My Cloud registering itself as a Cloud home does.
 * `env`: more of both servers' environment (a fake HighLevel and its relay). `cloudEngine`: lines run at the start of My
 * Cloud's synthetic Claude CLI, to script its turns (fake-claude-cli.ts). */
export async function launchCloudSendFixture({ onePasswordToken, cloudOnePasswordToken = onePasswordToken, toolCalls = 0, broker, env = {}, cloudEnv = {}, cloudEngine = "", desktopEngine = "", space, cloudSignedIn = true, team }: {
  onePasswordToken: string; cloudOnePasswordToken?: string; toolCalls?: number;
  /** A Team Cloud too (OMB_CLOUD_ROLE=team), with its own environment and synthetic Claude CLI lines. */
  team?: { id: string; name: string; env?: NodeJS.ProcessEnv; engine?: string };
  broker?: { url: string; install(): Promise<{ id: string; token: string; userId: string }> };
  env?: NodeJS.ProcessEnv;
  /** My Cloud's own environment only (a store limit, say). */
  cloudEnv?: NodeJS.ProcessEnv;
  cloudEngine?: string;
  /** The same for this computer's synthetic Claude CLI. */
  desktopEngine?: string;
  /** My Cloud's plan disk and the Admin's grow, as main gives them to a move. */
  space?: { disk(): unknown; grow(sizeGb: number): Promise<unknown> };
  /** False: My Cloud's own Claude is signed out, as on a new Cloud. */
  cloudSignedIn?: boolean;
}): Promise<CloudSendFixture> {
  const root = mkdtempSync(join(tmpdir(), "omb-cloud-send-"));
  const secret = randomBytes(32).toString("base64url");
  const ownerCapability = randomBytes(32).toString("base64url");
  const answers: string[] = [];
  const labels: string[] = [];
  let logs = "";
  const children = new Set<ChildProcess>();
  const remember = async (response: Response) => { answers.push(await response.clone().text()); return response; };

  async function start(name: string, own: NodeJS.ProcessEnv, port: number, extra: string[] = [], ipc = false, acceptedToken = onePasswordToken, calls = 0, engine = "", signedIn = true): Promise<ChildProcess> {
    const home = join(root, name);
    const dataDir = join(home, ".openmausbot");
    mkdirSync(dataDir, { recursive: true });
    const cli = join(home, "fixture-claude.mjs");
    const tools = calls ? JSON.stringify(Array.from({ length: calls }, (_, i) => ({ name: "Bash", input: { command: `echo step ${i}` } }))) : "";
    writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify(${signedIn ? '{ loggedIn: true, email: "person@example.test" }' : '{ loggedIn: false, authMethod: "none" }'})); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
process.env.FAKE_CLAUDE_FIXTURE_DIR = ${JSON.stringify(home)};
${tools ? `process.env.FAKE_CLAUDE_TOOL_CALLS = ${JSON.stringify(tools)};` : ""}
${engine}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
    if (!existsSync(join(dataDir, "config.json"))) writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
    } }));
    const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
    const child = spawn(process.execPath, ["--import", offline, ...extra, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_DUCKDB_DIR: fakeOnePassword(join(home, "native"), acceptedToken), ...env, ...own },
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
  const desktopPort = await freePortBlock([0, 1]);
  const desktopBase = `http://127.0.0.1:${desktopPort}`;
  const desktopInstallation = broker ? await broker.install() : null;
  const startDesktop = async () => {
    const child = await start("desktop", { OMB_DESKTOP_PARENT: "1",
      ...(broker && desktopInstallation ? { OMB_COMPOSIO_BROKER_URL: broker.url, OMB_COMPOSIO_BROKER_TOKEN: desktopInstallation.token } : {}) }, desktopPort, ["--import", parentPort], true, onePasswordToken, toolCalls, desktopEngine);
    child.send({ type: "openmausbot:desktop-mutation-token", token: ownerCapability });
    return child;
  };
  let desktop = await startDesktop();
  const cloudPort = await freePortBlock([0, 1]);
  const cloudBase = `http://127.0.0.1:${cloudPort}`;
  const startCloud = (more: NodeJS.ProcessEnv = {}) => start("cloud", { OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
    OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${CLOUD_HOST}`, ...(broker ? { OMB_COMPOSIO_BROKER_URL: broker.url } : {}), ...cloudEnv, ...more }, cloudPort, [], false, cloudOnePasswordToken, 0, cloudEngine, cloudSignedIn);
  let cloud = await startCloud();

  const mintCode = async (label: string) => {
    const body = JSON.stringify({ label, ttlSeconds: 300 });
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
    const response = await fetch(`${cloudBase}/api/cloud/pairing`, { method: "POST", headers: { ...EDGE, "content-type": "application/json",
      "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` }, body });
    return ((await response.json()) as { code: string }).code;
  };
  const pairOwner = async () => {
    const paired = await fetch(`${cloudBase}/api/auth/pair`, { method: "POST", headers: { ...EDGE, "content-type": "application/json" }, body: JSON.stringify({ code: await mintCode("OpenMausBot app (Cloud)") }) });
    return ((await paired.json()) as { token: string }).token;
  };
  let owner = await pairOwner();
  const signedRequest = async (base: string, method: string, path: string, body: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
    const init: RequestInit = { method, headers: { ...EDGE, ...(body ? { "content-type": "application/json" } : {}),
      "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudRequestSignature(secret, timestamp, nonce, method, path, body)}` } };
    if (body) init.body = body;
    const response = await remember(await fetch(`${base}${path}`, init));
    return { status: response.status, body: parse(await response.text()) };
  };
  const CAPABILITY_KEY = randomBytes(16).toString("hex");
  let teamFixture: CloudTeamFixture | null = null;
  if (team) {
    const teamPort = await freePortBlock([0, 1]);
    const teamBase = `http://127.0.0.1:${teamPort}`;
    // Windows' child.kill("SIGTERM") ends a process at once, without Node's signal handlers, so the server never closes
    // its session registry and its next start drops every member's session, as after a crash. There the team server is
    // asked to stop over IPC and runs its own SIGTERM shutdown (as server/acp-shutdown.e2e.test.ts does).
    const stopOverIpc = process.platform === "win32";
    const stopOnMessage = `data:text/javascript,${encodeURIComponent('process.on("message", (message) => { if (message === "stop") process.emit("SIGTERM"); }); process.channel?.unref();')}`;
    const startTeam = (more: NodeJS.ProcessEnv = {}) => start("team", { OMB_CLOUD_ROLE: "team", OMB_CLOUD_TEAM_ID: team.id, OMB_CLOUD_TEAM_NAME: team.name,
      OMB_CLOUD_MACHINE_ID: "0d9e8f7a-6b5c-4d3e-9f8a-7b6c5d4e3f2a", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test", OMB_CLOUD_BOOTSTRAP_SECRET: secret,
      OMB_PUBLIC_URL: `https://${CLOUD_HOST}`, OMB_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY, ...(broker ? { OMB_COMPOSIO_BROKER_URL: broker.url } : {}), ...team.env, ...more },
      teamPort, stopOverIpc ? ["--import", stopOnMessage] : [], stopOverIpc, onePasswordToken, 0, team.engine ?? "", true);
    let teamServer = await startTeam();
    const as: CloudTeamFixture["as"] = async (token, method, path, body, headers = {}) => {
      const init: RequestInit = { method, headers: { ...EDGE, authorization: `Bearer ${token}`, ...headers,
        ...(body === undefined || body instanceof Uint8Array ? {} : { "content-type": "application/json" }) } };
      if (body !== undefined) init.body = body instanceof Uint8Array ? body : JSON.stringify(body);
      const response = await remember(await fetch(`${teamBase}${path}`, init));
      return { status: response.status, body: parse(await response.text()) };
    };
    teamFixture = {
      base: teamBase, home: join(root, "team"), id: team.id, name: team.name,
      async grant(member) {
        const body = JSON.stringify({ label: "OpenMausBot app (Team Cloud)", ttlSeconds: 300, team: { id: team.id, name: team.name }, member });
        const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
        const minted = await fetch(`${teamBase}/api/cloud/pairing`, { method: "POST", headers: { ...EDGE, "content-type": "application/json",
          "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` }, body });
        if (minted.status !== 200) throw Object.assign(new Error(`team pairing ${minted.status}`), { status: minted.status });
        return { origin: teamBase, code: ((await minted.json()) as { code: string }).code, expiresAt: Date.now() + 300_000 };
      },
      async pair(member, options = {}) {
        const claims = options.body ?? { team: { id: team.id, name: team.name }, ...(member ? { member } : {}) };
        const body = JSON.stringify({ label: options.label ?? "OpenMausBot app (Team Cloud)", ttlSeconds: 300, ...claims });
        const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
        const minted = await remember(await fetch(`${teamBase}/api/cloud/pairing`, { method: "POST", headers: { ...EDGE, "content-type": "application/json",
          "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(options.secret ?? secret, timestamp, nonce, body)}` }, body }));
        const grant = parse(await minted.text());
        if (minted.status !== 200) return { status: minted.status, body: grant, token: null };
        const paired = await remember(await fetch(`${teamBase}/api/auth/pair`, { method: "POST", headers: { ...EDGE, "content-type": "application/json" }, body: JSON.stringify({ code: grant.code }) }));
        const session = parse(await paired.text());
        return { status: paired.status, body: session, token: paired.status === 200 ? session.token as string : null };
      },
      as,
      signed: (method, path, body) => signedRequest(teamBase, method, path, body === undefined ? "" : JSON.stringify(body)),
      async capability(botId, threadId) {
        // A loopback caller with the private key, as the harness mints one: never through the edge.
        const minted = await fetch(`${teamBase}/api/testing/internal-capability`, { method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": CAPABILITY_KEY }, body: JSON.stringify({ botId, threadId }) });
        const answer = parse(await minted.text());
        if (minted.status !== 200 && minted.status !== 201) throw new Error(`no test capability: ${minted.status} ${JSON.stringify(answer)}`);
        return answer.token as string;
      },
      async relaunch(more = {}) {
        if (teamServer.connected) {
          teamServer.send("stop");
          await waitForExit(teamServer, { graceMs: 10_000 });
        } else await waitForExit(teamServer, { signal: "SIGTERM" });
        if (stopOverIpc && teamServer.exitCode !== 0) throw new Error(`team fixture did not stop cleanly (exitCode=${teamServer.exitCode}, signalCode=${teamServer.signalCode})`);
        teamServer = await startTeam(more);
      },
    };
  }

  const local = async (method: string, path: string, body?: unknown) => {
    const response = await remember(await fetch(`${desktopBase}${path}`, { method, headers: {
      "x-openmausbot-desktop-owner": ownerCapability, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: parse(await response.text()) };
  };
  const onCloud = async (method: string, path: string, body?: unknown) => {
    const response = await remember(await fetch(`${cloudBase}${path}`, { method, headers: { ...EDGE, authorization: `Bearer ${owner}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: parse(await response.text()) };
  };
  for (let tries = 0; (await local("GET", "/api/bots")).status !== 200 && tries < 50; tries++) await new Promise((resolve) => setTimeout(resolve, 100));

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const port = { postMessage: (message: unknown) => { desktop.send(message as object); } };
  const journalFile = join(root, "one-home.json");
  const teamJournalFile = join(root, "team-moves.json");
  const account: CloudSendFixture["account"] = {
    state: { status: "connected", account: { id: "acct-fixture", email: "person@example.test" }, entitlement: { plan: "pro", status: "active", expiresAt: null, version: 1 },
      machine: { status: "ready", origin: cloudBase } },
    exportHome: async () => ({ notHeld: true }),
    pairTeam: async () => { throw Object.assign(new Error("You're no longer in this team."), { gone: true }); },
  };
  const spies: CloudSendFixture["spies"] = { lent: [], phoneStops: 0, phoneStarts: 0, opened: [], relaunches: 0 };
  const fixture = { beforeJournalWrite: null as CloudSendFixture["beforeJournalWrite"], intercept: null as CloudSendFixture["intercept"], beforeTeamJournalWrite: null as CloudSendFixture["beforeTeamJournalWrite"] };
  const chatRequests: CloudSendFixture["chatRequests"] = [];
  const sessions: CloudSendFixture["sessions"] = [];
  const throughEdge = (bearer: string | null) => async (url: string | URL | Request, init: RequestInit = {}) => {
    const forged = fixture.intercept?.(String(url), init);
    if (forged) return forged;
    if (String(url).endsWith("/api/cloud-send/chats") && init.method === "POST" && typeof init.body === "string") {
      chatRequests.push((JSON.parse(init.body) as { conversations: Array<{ threadId: string; rows: unknown[] }> }).conversations.map((entry) => ({ threadId: entry.threadId, rows: entry.rows.length })));
    }
    if (String(url).endsWith("/api/auth/pair") && typeof init.body === "string") {
      const { label } = JSON.parse(init.body) as { label: string };
      labels.push(label);
      sessions.push({ label, background: (init.headers as Record<string, string>)["x-omb-background"] === "1" });
    }
    return remember(await fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, ...EDGE, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } }));
  };
  const wire = () => installOneHome({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    cloudPage: (event) => (event as { page?: "local" | "cloud" })?.page ?? null,
    server: () => port,
    localRequest: async (route, init = {}) => remember(await fetch(`${desktopBase}${route}`, { ...init, headers: { ...init.headers as Record<string, string>, "x-openmausbot-desktop-owner": ownerCapability } })),
    home: () => ({ origin: cloudBase, grant: async () => ({ origin: cloudBase, code: await mintCode("OpenMausBot app (Cloud)") }) }),
    cookieFetch: throughEdge(owner) as typeof fetch,
    reconnect: async () => false,
    power: { asleep: () => false },
    file: () => join(root, "cloud-send.json"),
    window: () => null,
    localOrigin: () => desktopBase,
    fetch: throughEdge(null) as typeof fetch,
    engineWaitMs: 2_000,
    ...(space ? { space } : {}),
    account: () => ({ state: () => account.state, pairHome: async () => ({ origin: cloudBase, code: await mintCode("OpenMausBot app (Cloud)"), expiresAt: Date.now() + 300_000 }), exportHome: (options) => account.exportHome(options),
      reportMove: async (options) => (account.reportMove ? account.reportMove(options) : false), reportKept: async (options) => (account.reportKept ? account.reportKept(options) : false),
      pairTeam: (teamId: string) => account.pairTeam(teamId) }),
    teamJournal: {
      read: () => { try { return JSON.parse(readFileSync(teamJournalFile, "utf8")); } catch { return null; } },
      write: (value: unknown) => { fixture.beforeTeamJournalWrite?.(value); writeFileSync(`${teamJournalFile}.tmp`, JSON.stringify(value ?? null)); renameSync(`${teamJournalFile}.tmp`, teamJournalFile); },
    },
    openTeam: (team: { id: string; name: string }) => { spies.opened.push(`team:${team.id}`); },
    journalFile: () => journalFile,
    journal: {
      read: () => { try { return JSON.parse(readFileSync(journalFile, "utf8")); } catch { return null; } },
      write: (value: unknown) => { fixture.beforeJournalWrite?.(value); writeFileSync(`${journalFile}.tmp`, JSON.stringify(value ?? null)); renameSync(`${journalFile}.tmp`, journalFile); },
    },
    tempRoot: () => join(root, "one-home-temp"),
    lend: async (projects) => { spies.lent.push(projects); },
    phone: { paired: () => true, stop: async () => { spies.phoneStops++; }, start: async () => { spies.phoneStarts++; } },
    openHome: () => { spies.opened.push("cloud"); },
    openLocal: () => { spies.opened.push("local"); },
    restart: () => { spies.relaunches++; },
    version: "0.1.120",
    log: (line: string) => { logs += `[main] ${line}\n`; },
  });
  let main = wire();
  const asks = createLoginHandoffClient();
  const older = () => createCloudSend({
    local: async (route, init) => remember(await fetch(`${desktopBase}${route}`, { method: init?.method ?? "GET", headers: { "x-openmausbot-desktop-owner": ownerCapability } })),
    cloud: {
      origin: () => cloudBase,
      asleep: () => false,
      read: (route) => throughEdge(owner)(`${cloudBase}${route}`, { headers: { accept: "application/json", ...BACKGROUND_HEADERS } }),
      open: () => openOwnerSession({ origin: cloudBase, grant: async () => ({ origin: cloudBase, code: await mintCode("OpenMausBot app (Cloud)") }) }, throughEdge(null) as typeof fetch),
    },
    handoff: (what) => asks.request(port, what as ConnectionAsk),
    store: {
      read: () => { try { return JSON.parse(readFileSync(join(root, "cloud-send.json"), "utf8")); } catch { return null; } },
      write: (value) => { const file = join(root, "cloud-send.json"); writeFileSync(`${file}.tmp`, JSON.stringify(value)); renameSync(`${file}.tmp`, file); },
    },
  });
  const reopened = () => { main.close(); main = wire(); };
  const desks: Array<{ close(): void }> = [];
  async function addDesk({ label }: { label: string }): Promise<CloudSendDesk> {
    const name = `desktop-${desks.length + 2}`, deskPort = await freePortBlock([0, 1]), base = `http://127.0.0.1:${deskPort}`;
    const capability = randomBytes(32).toString("base64url");
    const startIt = async () => {
      const child = await start(name, { OMB_DESKTOP_PARENT: "1", OMB_ENVIRONMENT_LABEL: label }, deskPort, ["--import", parentPort], true, onePasswordToken, toolCalls, desktopEngine);
      child.send({ type: "openmausbot:desktop-mutation-token", token: capability });
      return child;
    };
    let child = await startIt();
    const deskLocal: CloudSendDesk["local"] = async (method, path, body) => {
      const response = await remember(await fetch(`${base}${path}`, { method, headers: { "x-openmausbot-desktop-owner": capability, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      return { status: response.status, body: parse(await response.text()) };
    };
    const ready = async () => { for (let tries = 0; (await deskLocal("GET", "/api/bots")).status !== 200 && tries < 50; tries++) await new Promise((resolve) => setTimeout(resolve, 100)); };
    await ready();
    const journalFile = join(root, `${name}-one-home.json`), keepFile = join(root, `${name}-one-home-keep.json`);
    const deskAccount: CloudSendDesk["account"] = { state: structuredClone(account.state), exportHome: async () => ({ notHeld: true }),
      pairTeam: async () => { throw Object.assign(new Error("You're no longer in this team."), { gone: true }); } };
    const teamJournal = join(root, `${name}-team-moves.json`);
    const spies: CloudSendDesk["spies"] = { lent: [], phoneStops: 0, phoneStarts: 0, opened: [], relaunches: 0 };
    const ipc = { postMessage: (message: unknown) => { child.send(message as object); } };
    const throughOwner = ((url: string | URL | Request, init?: RequestInit) => throughEdge(owner)(url, init)) as typeof fetch;
    const wireIt = () => installOneHome({
      ipcMain: { handle: () => {} },
      cloudPage: (event) => (event as { page?: "local" | "cloud" })?.page ?? null,
      server: () => ipc,
      localRequest: async (route, init = {}) => remember(await fetch(`${base}${route}`, { ...init, headers: { ...init.headers as Record<string, string>, "x-openmausbot-desktop-owner": capability } })),
      home: () => ({ origin: cloudBase, grant: async () => ({ origin: cloudBase, code: await mintCode("OpenMausBot app (Cloud)") }) }),
      cookieFetch: throughOwner,
      reconnect: async () => false,
      power: { asleep: () => false },
      file: () => join(root, `${name}-cloud-send.json`),
      window: () => null,
      localOrigin: () => base,
      fetch: throughEdge(null) as typeof fetch,
      engineWaitMs: 2_000,
      account: () => ({ state: () => deskAccount.state, pairHome: async () => ({ origin: cloudBase, code: await mintCode("OpenMausBot app (Cloud)"), expiresAt: Date.now() + 300_000 }), exportHome: (options) => deskAccount.exportHome(options),
        reportMove: async (options) => (deskAccount.reportMove ? deskAccount.reportMove(options) : false), reportKept: async (options) => (deskAccount.reportKept ? deskAccount.reportKept(options) : false),
        pairTeam: (teamId: string) => deskAccount.pairTeam(teamId) }),
      teamJournal: {
        read: () => { try { return JSON.parse(readFileSync(teamJournal, "utf8")); } catch { return null; } },
        write: (value: unknown) => { writeFileSync(`${teamJournal}.tmp`, JSON.stringify(value ?? null)); renameSync(`${teamJournal}.tmp`, teamJournal); },
      },
      journalFile: () => journalFile,
      keep: {
        read: () => { try { return JSON.parse(readFileSync(keepFile, "utf8")); } catch { return null; } },
        write: (value: unknown) => { writeFileSync(`${keepFile}.tmp`, JSON.stringify(value ?? null)); renameSync(`${keepFile}.tmp`, keepFile); },
      },
      tempRoot: () => join(root, `${name}-one-home-temp`),
      lend: async (projects) => { spies.lent.push(projects); },
      phone: { paired: () => true, stop: async () => { spies.phoneStops++; }, start: async () => { spies.phoneStarts++; } },
      openHome: () => { spies.opened.push("cloud"); },
      openLocal: () => { spies.opened.push("local"); },
      restart: () => { spies.relaunches++; },
      version: "0.1.120",
      log: (line: string) => { logs += `[main ${label}] ${line}\n`; },
    });
    let deskMain = wireIt();
    const listenIt = () => { child.on("message", (message) => deskMain.receive(ipc, message)); };
    listenIt();
    desks.push({ close: () => deskMain.close() });
    return {
      base, dataDir: join(root, name, ".openmausbot"), local: deskLocal, account: deskAccount, journalFile, spies,
      oneHome: { kick: () => deskMain.kick(), view: () => deskMain.view(), away: () => deskMain.away() },
      async relaunch({ kill = true } = {}) {
        deskMain.close();
        await waitForExit(child, { signal: kill ? "SIGKILL" : "SIGTERM" });
        child = await startIt();
        await ready();
        deskMain = wireIt();
        listenIt();
      },
    };
  }
  const listen = () => {
    desktop.on("message", (message) => main.receive(port, message));
    desktop.on("message", (message) => { asks.receive(port, message); });
  };
  listen();

  return {
    root, desktopBase, cloudBase, get owner() { return owner; }, ownerCapability, edge: EDGE, answers, labels, logs: () => logs, local, onCloud, desktopInstallation,
    account, journalFile, spies, teamJournalFile,
    get beforeTeamJournalWrite() { return fixture.beforeTeamJournalWrite; },
    set beforeTeamJournalWrite(hook) { fixture.beforeTeamJournalWrite = hook; },
    teamMove: { start: (input) => main.teamMove.start(input), kick: () => main.teamMove.kick(), view: () => main.teamMove.view(), retry: () => main.teamMove.retry(),
      seen: () => main.teamMove.seen(), journal: () => main.teamMove.journal() },
    get beforeJournalWrite() { return fixture.beforeJournalWrite; },
    set beforeJournalWrite(hook) { fixture.beforeJournalWrite = hook; },
    get intercept() { return fixture.intercept; },
    set intercept(hook) { fixture.intercept = hook; },
    oneHome: { kick: () => main.kick(), view: () => main.view(), away: () => main.away() },
    async relaunch({ kill = true, cloud: cloudMore } = {}) {
      main.close();
      await waitForExit(desktop, { signal: kill ? "SIGKILL" : "SIGTERM" });
      if (cloudMore) {
        await waitForExit(cloud, { signal: "SIGTERM" });
        cloud = await startCloud(cloudMore);
        owner = await pairOwner();
      }
      desktop = await startDesktop();
      for (let tries = 0; (await local("GET", "/api/bots")).status !== 200 && tries < 50; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
      main = wire();
      listen();
    },
    handoff: (what) => asks.request(port, what as ConnectionAsk),
    async picture(bytes) {
      const response = await fetch(`${desktopBase}/api/attachments`, { method: "POST", headers: { "x-openmausbot-desktop-owner": ownerCapability, "content-type": "image/png" }, body: bytes });
      return `/api/attachments/${((await response.json()) as { path: string }).path.split(/[\\/]/).pop()}`;
    },
    call: <T>(channel: string, page: "local" | "cloud", ...args: unknown[]) => Promise.resolve(handlers.get(channel)!({ page }, ...args)) as Promise<T>,
    async olderSend(input = {}) {
      try { return await older().send({ ...input, reason: "button" }); } finally { reopened(); }
    },
    olderCompare: () => older().compare(),
    move: (options) => main.move(options),
    check: () => main.check(),
    sessions,
    chatRequests,
    team: teamFixture,
    grant: async (label) => ({ origin: cloudBase, code: await mintCode(label), expiresAt: Date.now() + 300_000 }),
    addDesk,
    async close() {
      main.close();
      for (const desk of desks) desk.close();
      for (const child of children) await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(root);
    },
  };
}
