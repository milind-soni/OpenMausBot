import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGhTools, type GhChild, type GhRun, type GhTools } from "./gh-cli.ts";
import { createGithubSignIn, DEVICE_CODE_TTL_MS, githubFolders, GithubSignInError, type GithubSignInDeps } from "./sign-in.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
// Assembled here, never written out whole: it only has to look like a GitHub token.
const TOKEN = ["gho", "Fixture0000000000000000000000000000x"].join("_");
const PASTED = ["github", "pat", "11FIXTURE0", "x".repeat(40)].join("_");
const MEMBER = `p_${"m".repeat(22)}`, OTHER = `p_${"o".repeat(22)}`;

class FakeChild extends EventEmitter implements GhChild {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals[] = [];
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  constructor(file: string, args: readonly string[], env: Record<string, string>) {
    super();
    this.file = file;
    this.args = args;
    this.env = env;
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killed.push(signal);
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
  /** What gh does once the code is entered: writes its config, then exits 0. */
  approve(login = "octo-fixture") {
    mkdirSync(this.env.GH_CONFIG_DIR!, { recursive: true });
    writeFileSync(join(this.env.GH_CONFIG_DIR!, "hosts.yml"), fixture("constructed/hosts.yml.txt").replaceAll("TOKEN", TOKEN).replaceAll("octo-fixture", login));
    this.emit("close", 0);
  }
  print(text: string) {
    this.stderr.write(text);
  }
}

interface Fake {
  tools: GhTools;
  children: FakeChild[];
  calls: Array<{ file: string; args: readonly string[]; env: Record<string, string> }>;
  set: { personal: string | null; version: [number, number, number] | null; pinned: string | null; onDisk: boolean; install: () => Promise<string>; personalStatus: GhRun; personalToken: GhRun; ownStatus: GhRun; winCreds: string[] | null };
  installs: () => number;
}

const ok = (stdout: string): GhRun => ({ code: 0, stdout, stderr: "" });

function fakeTools(): Fake {
  const children: FakeChild[] = [];
  const calls: Fake["calls"] = [];
  let installs = 0;
  const set: Fake["set"] = {
    personal: null, version: [2, 103, 3], pinned: "/data/tools/standalone/github-cli/bin/gh", onDisk: true, install: () => Promise.resolve("/data/tools/standalone/github-cli/bin/gh"), winCreds: [],
    personalStatus: ok(fixture("2.102.0/status-json-signedout.stdout.txt")), personalToken: { code: 1, stdout: "", stderr: "no oauth token found for github.com" },
    ownStatus: ok(fixture("constructed/status-json-success.stdout.txt")),
  };
  const tools: GhTools = {
    personal: () => set.personal,
    version: async () => set.version,
    pinnedReady: () => set.pinned,
    pinnedOnDisk: () => set.pinned !== null || set.onDisk,
    install: async () => {
      installs++;
      const file = await set.install();
      set.pinned = file;
      return file;
    },
    spawn(file, args, env) {
      const child = new FakeChild(file, args, env);
      children.push(child);
      return child;
    },
    async run(file, args, env) {
      calls.push({ file, args, env });
      const personal = env.GH_CONFIG_DIR === undefined;
      if (args[0] === "auth" && args[1] === "status") return personal ? set.personalStatus : set.ownStatus;
      if (args[0] === "auth" && args[1] === "token") {
        if (personal) return set.personalToken;
        return existsSync(join(env.GH_CONFIG_DIR!, "hosts.yml")) ? ok(`${TOKEN}\n`) : { code: 1, stdout: "", stderr: "no oauth token found for github.com" };
      }
      if (args[0] === "api" && args[1] === "user/orgs") return ok("acme\nwidgets\n");
      return { code: 1, stdout: "", stderr: "unknown command" };
    },
    windowsGhCredentials: async () => set.winCreds,
  };
  return { tools, children, calls, set, installs: () => installs };
}

function fakeVault(): GithubSignInDeps["vault"] & { saved: Map<string, { token: string; login: string }> } {
  const saved = new Map<string, { token: string; login: string }>();
  return {
    saved,
    githubToken: (audience) => saved.get(audience) ?? null,
    setGithubToken: (audience, value) => {
      if (value) saved.set(audience, value);
      else saved.delete(audience);
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

let dataDir: string;
let clock: number;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-github-"));
  clock = 1_000_000;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

function setup(options: { team?: boolean; fetchImpl?: typeof fetch; platform?: NodeJS.Platform } = {}) {
  const fake = fakeTools(), vault = fakeVault();
  const remembered: string[] = [];
  const signIn = createGithubSignIn({ dataDir, team: options.team ?? false, tools: fake.tools, vault, now: () => clock, fetchImpl: options.fetchImpl, remember: (token) => remembered.push(token), platform: options.platform ?? "linux" });
  return { ...fake, vault, signIn, remembered };
}

async function showCode(fake: ReturnType<typeof setup>, audience = "owner") {
  const started = await fake.signIn.start(audience);
  expect(started.state).toBe("installing");
  await settle();
  const child = fake.children.at(-1)!;
  child.print(fixture("2.103.3/login.stderr.txt"));
  await settle();
  return child;
}

describe("GitHub sign-in with GitHub CLI's device code", () => {
  it("shows the code, then is signed in once it is entered on GitHub", async () => {
    vi.stubEnv("GH_TOKEN", "from-the-server-environment");
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
    const fake = setup();
    expect(await fake.signIn.status("owner")).toEqual({ state: "signed-out", download: false });
    const child = await showCode(fake);
    expect(await fake.signIn.status("owner")).toEqual({ state: "signing-in", code: "B1A5-0221", verificationUrl: "https://github.com/login/device", expiresAt: clock + DEVICE_CODE_TTL_MS });
    // A second Start joins the one running.
    expect((await fake.signIn.start("owner")).state).toBe("signing-in");
    expect(fake.children).toHaveLength(1);

    expect(child.file).toBe("/data/tools/standalone/github-cli/bin/gh");
    expect(child.args).toEqual(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--insecure-storage", "--clipboard=false", "--expiring=false"]);
    const folders = githubFolders(dataDir, "owner");
    expect(child.env).toMatchObject({ HOME: folders.home, GH_CONFIG_DIR: folders.config, GH_PROMPT_DISABLED: "1", GH_TELEMETRY: "false", NO_COLOR: "1" });
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]) expect(child.env[name], name).toBeUndefined();
    // Never the person's session bus: an address in the private folder where nothing listens.
    expect(child.env.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${folders.home}/.run/no-bus`);

    child.approve();
    await settle();
    expect(await fake.signIn.status("owner")).toEqual({ state: "signed-in", login: "octo-fixture", source: "mausbot", scopes: ["gist", "read:org", "repo"], orgs: ["acme", "widgets"], checkedAt: clock });
    expect(await fake.signIn.token()).toBe(TOKEN);
    expect(fake.remembered).toEqual([TOKEN]);
    // Cached: asking again does not ask GitHub, until someone asks for a check or a git action reports a refusal.
    const statusCalls = () => fake.calls.filter((call) => call.args[1] === "status").length;
    const before = statusCalls();
    await fake.signIn.status("owner");
    expect(statusCalls()).toBe(before);
    await fake.signIn.status("owner", { check: true });
    expect(statusCalls()).toBe(before + 1);
    fake.set.ownStatus = ok(fixture("2.103.3/status-json-invalid.stdout.txt"));
    fake.signIn.reportAuthFailure("owner");
    expect(await fake.signIn.status("owner")).toMatchObject({ state: "invalid", login: "octo-fixture", source: "mausbot" });
  });

  it("reports an expired code when gh gives up, and when the code's time passed while gh still waits", async () => {
    const fake = setup();
    const child = await showCode(fake);
    child.print(fixture("2.103.3/login-expired.stderr.txt").split("\n").slice(3).join("\n"));
    child.emit("close", 1);
    await settle();
    expect(await fake.signIn.status("owner")).toMatchObject({ state: "signed-out", last: { outcome: "expired" } });

    const second = await showCode(fake);
    clock += DEVICE_CODE_TTL_MS + 1;
    expect(await fake.signIn.status("owner")).toMatchObject({ state: "signed-out", last: { outcome: "expired" } });
    expect(second.killed).toEqual(["SIGTERM"]);
    expect(await fake.signIn.token()).toBeNull();
  });

  it("cancel stops gh, and gh's own exit afterwards changes nothing", async () => {
    const fake = setup();
    const child = await showCode(fake);
    expect(await fake.signIn.cancel("owner")).toMatchObject({ state: "signed-out", last: { outcome: "cancelled" } });
    expect(child.killed).toEqual(["SIGTERM"]);
    child.approve();
    await settle();
    // gh wrote its file after the cancel: that is a sign-in GitHub made, so it shows; the attempt itself stays cancelled.
    expect((await fake.signIn.status("owner")).state).toBe("signed-in");
  });

  it("a failed login says why, in one line of its own", async () => {
    const fake = setup();
    const child = await showCode(fake);
    child.print(fixture("2.103.3/login-network-failure.stderr.txt").split("\n").slice(3).join("\n"));
    child.emit("close", 1);
    await settle();
    expect(await fake.signIn.status("owner")).toMatchObject({ state: "signed-out", last: { outcome: "failed", reason: "GitHub could not be reached from this server. Check its network connection, then try again." } });
  });

  it("with no gh anywhere, Start downloads the pinned one first, and says so when that fails", async () => {
    const fake = setup();
    fake.set.pinned = null;
    fake.set.onDisk = false;
    let finish!: (file: string) => void;
    fake.set.install = () => new Promise((resolve) => { finish = resolve; });
    expect(await fake.signIn.status("owner")).toEqual({ state: "signed-out", download: true });
    expect(await fake.signIn.start("owner")).toEqual({ state: "installing" });
    expect(fake.children).toHaveLength(0);
    finish("/data/tools/standalone/github-cli/bin/gh");
    await settle();
    expect(fake.children).toHaveLength(1);
    await fake.signIn.cancel("owner");

    const broken = setup();
    broken.set.pinned = null;
    broken.set.onDisk = false;
    broken.set.install = () => Promise.reject(new Error("GitHub CLI has no download for this computer."));
    await broken.signIn.start("owner");
    await settle();
    expect(await broken.signIn.status("owner")).toEqual({ state: "signed-out", download: true, last: { outcome: "failed", reason: "GitHub CLI has no download for this computer.", at: clock } });
    expect(broken.children).toHaveLength(0);
  });

  it("a download that fails its checksum installs nothing and the sign-in says so", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("this is not GitHub CLI"), { status: 200 })) as unknown as typeof fetch;
    const tools = createGhTools({ dataDir, personalAllowed: () => false, install: { fetchImpl, platformKey: "linux-x64" } });
    const spawn = vi.spyOn(tools, "spawn");
    const signIn = createGithubSignIn({ dataDir, team: false, tools, vault: fakeVault(), now: () => clock });
    expect(await signIn.start("owner")).toEqual({ state: "installing" });
    for (let i = 0; i < 250 && (await signIn.status("owner")).state === "installing"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const status = await signIn.status("owner");
    expect(status).toMatchObject({ state: "signed-out", download: true, last: { outcome: "failed" } });
    expect((status as { last?: { reason?: string } }).last?.reason).toMatch(/safety check/u);
    expect(fetchImpl).toHaveBeenCalledWith("https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz", expect.anything());
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, "tools", "standalone", "github-cli", "2.103.3"))).toBe(false);
  });
});

describe("the person's own GitHub CLI on This computer", () => {
  it("is used to sign in when it is new enough, and the pinned copy when it is not", async () => {
    const fake = setup();
    fake.set.personal = "/opt/homebrew/bin/gh";
    fake.set.version = [2, 102, 0];
    await showCode(fake);
    expect(fake.children[0]!.file).toBe("/opt/homebrew/bin/gh");
    expect(fake.children[0]!.args).not.toContain("--expiring=false");
    await fake.signIn.cancel("owner");

    fake.set.version = [2, 40, 1];
    await showCode(fake);
    expect(fake.children[1]!.file).toBe("/data/tools/standalone/github-cli/bin/gh");
  });

  it("is reported as the sign-in when it works, and Start is refused rather than touching its credential store", async () => {
    const fake = setup();
    fake.set.personal = "/usr/local/bin/gh";
    fake.set.personalStatus = ok(fixture("constructed/status-json-success.stdout.txt"));
    fake.set.personalToken = ok(`${TOKEN}\n`);
    expect(await fake.signIn.status("owner")).toMatchObject({ state: "signed-in", login: "octo-fixture", source: "cli" });
    await expect(fake.signIn.start("owner")).rejects.toMatchObject({ status: 409 });
    expect(fake.children).toHaveLength(0);
    expect(await fake.signIn.token()).toBe(TOKEN);
    // Sign out is theirs to do, in their own terminal.
    await expect(fake.signIn.signOut("owner")).rejects.toMatchObject({ status: 409 });
    // Its own text format (before --json) counts the same.
    const text = setup();
    text.set.personal = "/usr/local/bin/gh";
    text.tools.run = async (_file, args) => (args.includes("--json") ? { code: 1, stdout: "", stderr: fixture("2.40.1/status-json.stderr.txt") } : ok(fixture("constructed/status-text-success-before-2.40.stdout.txt")));
    await expect(text.signIn.start("owner")).rejects.toBeInstanceOf(GithubSignInError);
    expect(text.children).toHaveLength(0);
  });

  it("a sign-in of theirs that GitHub refuses (401) shows as such, and OpenMausBot's own sign-in may then start", async () => {
    const fake = setup();
    fake.set.personal = "/usr/local/bin/gh";
    fake.set.version = [2, 40, 1];
    fake.set.personalStatus = ok(fixture("2.103.3/status-json-invalid.stdout.txt"));
    expect(await fake.signIn.status("owner")).toMatchObject({ state: "invalid", login: "octo-fixture", source: "cli" });
    expect((await fake.signIn.start("owner")).state).toBe("installing");
  });

  it("when theirs cannot be checked (no network, an old gh's text, an answer it cannot read), Start is refused", async () => {
    const offline = setup();
    offline.set.personal = "/usr/local/bin/gh";
    offline.set.personalStatus = ok(fixture("2.103.3/status-json-offline.stdout.txt"));
    expect(await offline.signIn.status("owner")).toMatchObject({ state: "signed-in", login: "octo-fixture", source: "cli", checkedAt: null });
    await expect(offline.signIn.start("owner")).rejects.toMatchObject({ status: 409 });

    const old = setup();
    old.set.personal = "/usr/local/bin/gh";
    old.tools.run = async (_file, args) => (args.includes("--json") ? { code: 1, stdout: "", stderr: "unknown flag: --json" } : ok(fixture("2.40.1/status-offline.stdout.txt")));
    await expect(old.signIn.start("owner")).rejects.toMatchObject({ status: 409 });

    const garbled = setup();
    garbled.set.personal = "/usr/local/bin/gh";
    garbled.tools.run = async () => ({ code: 1, stdout: "", stderr: "segmentation fault" });
    await expect(garbled.signIn.start("owner")).rejects.toMatchObject({ status: 409 });
    for (const fake of [offline, old, garbled]) expect(fake.children).toHaveLength(0);
  });

  it("its own sign-in stays signed in, unchecked, when GitHub cannot be reached", async () => {
    const fake = setup();
    const child = await showCode(fake);
    child.approve();
    await settle();
    fake.set.ownStatus = ok(fixture("2.103.3/status-json-offline.stdout.txt"));
    expect(await fake.signIn.status("owner")).toMatchObject({ state: "signed-in", login: "octo-fixture", source: "mausbot", checkedAt: null });
    fake.set.ownStatus = { code: 1, stdout: "", stderr: "" };
    expect(await fake.signIn.status("owner", { check: true })).toMatchObject({ state: "signed-in", login: "octo-fixture", checkedAt: null });
  });

  it("is never looked at on a Team Cloud", async () => {
    const fake = setup({ team: true });
    fake.set.personal = "/usr/local/bin/gh";
    fake.set.personalStatus = ok(fixture("constructed/status-json-success.stdout.txt"));
    fake.set.personalToken = ok(`${TOKEN}\n`);
    expect(await fake.signIn.status(MEMBER)).toMatchObject({ state: "signed-out" });
    expect(await fake.signIn.token(MEMBER)).toBeNull();
    expect(fake.calls.filter((call) => call.env.GH_CONFIG_DIR === undefined)).toEqual([]);
  });
});

describe("a pasted token, sign out, and whose sign-in is whose", () => {
  const github = (login: string | null) => vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    if (!login || auth !== `Bearer ${PASTED}`) return new Response("{}", { status: 401 });
    return Response.json({ login }, { headers: { "x-oauth-scopes": "" } });
  }) as unknown as typeof fetch;

  it("keeps a pasted token in the Vault, never in an answer, and replaces OpenMausBot's own gh sign-in", async () => {
    const fake = setup({ fetchImpl: github("octo-fixture") });
    const child = await showCode(fake);
    child.approve();
    await settle();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")];
    const saved = await fake.signIn.saveToken("owner", ` ${PASTED}\n`);
    expect(saved).toMatchObject({ state: "signed-in", login: "octo-fixture", source: "token", scopes: [] });
    expect(JSON.stringify(saved)).not.toContain(PASTED);
    expect(existsSync(githubFolders(dataDir, "owner").root)).toBe(false);
    expect(fake.vault.saved.get("owner")).toEqual({ token: PASTED, login: "octo-fixture" });
    expect(await fake.signIn.token()).toBe(PASTED);
    expect(JSON.stringify(await fake.signIn.status("owner", { check: true }))).not.toContain(PASTED);
    for (const log of logs) for (const call of log.mock.calls) expect(JSON.stringify(call)).not.toContain(PASTED);

    await expect(fake.signIn.saveToken("owner", "not a token")).rejects.toMatchObject({ status: 400 });
    // A rate-limited 403 is not a refusal: the saved token stays, shown unchecked.
    const limited = vi.fn(async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as unknown as typeof fetch;
    const later = createGithubSignIn({ dataDir, team: false, tools: fake.tools, vault: fake.vault, now: () => clock, fetchImpl: limited });
    expect(await later.status("owner")).toMatchObject({ state: "signed-in", source: "token", checkedAt: null });
    await expect(later.saveToken("owner", PASTED)).rejects.toMatchObject({ status: 502 });
    const refused = setup({ fetchImpl: github(null) });
    await expect(refused.signIn.saveToken("owner", PASTED)).rejects.toMatchObject({ status: 400 });
    expect(refused.vault.saved.size).toBe(0);
  });

  it("sign out forgets the folder and the token without running gh auth logout", async () => {
    const fake = setup();
    const child = await showCode(fake);
    child.approve();
    await settle();
    expect(await fake.signIn.signOut("owner")).toEqual({ state: "signed-out", download: false });
    expect(existsSync(githubFolders(dataDir, "owner").root)).toBe(false);
    expect(fake.calls.some((call) => call.args.includes("logout"))).toBe(false);
    expect(await fake.signIn.token()).toBeNull();
  });

  it("on a Team Cloud each member has their own, and no one falls back to another's or the team's", async () => {
    const fake = setup({ team: true });
    const child = await showCode(fake, MEMBER);
    expect(child.env.GH_CONFIG_DIR).toBe(githubFolders(dataDir, MEMBER).config);
    child.approve("member-login");
    await settle();
    expect(await fake.signIn.token(MEMBER)).toBe(TOKEN);
    expect(await fake.signIn.token(OTHER)).toBeNull();
    expect(await fake.signIn.token()).toBeNull();
    expect(await fake.signIn.token("owner")).toBeNull();
    expect((await fake.signIn.status(OTHER)).state).toBe("signed-out");
    await expect(fake.signIn.status("owner")).rejects.toMatchObject({ status: 403 });
    await expect(fake.signIn.start("../owner")).rejects.toMatchObject({ status: 403 });
    fake.signIn.forgetPerson(MEMBER);
    expect(existsSync(githubFolders(dataDir, MEMBER).root)).toBe(false);
    expect(await fake.signIn.token(MEMBER)).toBeNull();
  });

  it("off a Team Cloud only the server's own sign-in exists", async () => {
    const fake = setup();
    await expect(fake.signIn.status(MEMBER)).rejects.toMatchObject({ status: 403 });
    expect(await fake.signIn.token(MEMBER)).toBeNull();
  });

  it("runs nothing until asked: creating it starts no gh, no download and no request", () => {
    const fake = setup({ fetchImpl: vi.fn() as unknown as typeof fetch });
    const install = vi.spyOn(fake.tools, "install");
    expect(fake.children).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(install).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, "github"))).toBe(false);
  });
});

describe("the accessor for server-side callers", () => {
  it("answers null until a sign-in is provided, then that sign-in's token, never another person's", async () => {
    const { githubToken, provideGithubSignIn, reportGithubAuthFailure } = await import("./token.ts");
    expect(await githubToken()).toBeNull();
    const fake = setup({ team: true });
    const child = await showCode(fake, MEMBER);
    child.approve();
    await settle();
    provideGithubSignIn(fake.signIn);
    try {
      expect(await githubToken(MEMBER)).toBe(TOKEN);
      expect(await githubToken(OTHER)).toBeNull();
      expect(await githubToken()).toBeNull();
      reportGithubAuthFailure(MEMBER);
      fake.set.ownStatus = ok(fixture("2.103.3/status-json-invalid.stdout.txt"));
      expect(await fake.signIn.status(MEMBER)).toMatchObject({ state: "invalid", source: "mausbot" });
    } finally {
      provideGithubSignIn(null);
    }
  });

  it("says from disk alone whether an audience has a sign-in, without running gh", async () => {
    const { githubSignedIn, provideGithubSignIn } = await import("./token.ts");
    expect(githubSignedIn("owner")).toBe(false);
    const team = setup({ team: true });
    expect(team.signIn.signedIn(MEMBER)).toBe(false);
    const child = await showCode(team, MEMBER);
    child.approve();
    await settle();
    const calls = team.calls.length;
    provideGithubSignIn(team.signIn);
    try {
      expect(githubSignedIn(MEMBER)).toBe(true);
      expect(githubSignedIn(OTHER)).toBe(false);
      expect(githubSignedIn("owner")).toBe(false);
      expect(githubSignedIn()).toBe(false);
      expect(team.calls.length).toBe(calls);
    } finally {
      provideGithubSignIn(null);
    }
    const own = setup();
    expect(own.signIn.signedIn()).toBe(false);
    own.vault.saved.set("owner", { token: TOKEN, login: "octo" });
    expect(own.signIn.signedIn()).toBe(true);
    own.vault.saved.clear();
    // A gh on PATH is not a sign-in: only one whose hosts file lists a github.com account.
    const ghConfig = join(dataDir, "personal-gh");
    mkdirSync(ghConfig);
    vi.stubEnv("GH_CONFIG_DIR", ghConfig);
    own.set.personal = "/usr/local/bin/gh";
    expect(own.signIn.signedIn("owner")).toBe(false);
    writeFileSync(join(ghConfig, "hosts.yml"), "github.com:\n    git_protocol: https\n    users:\n        octo:\n    user: octo\n");
    expect(own.signIn.signedIn("owner")).toBe(true);
    expect(own.signIn.signedIn(MEMBER)).toBe(false);
    own.set.personal = null;
    expect(own.signIn.signedIn("owner")).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("only Start downloads, and overlapping asks share one answer", () => {
  it("a signed-in folder with no pinned gh on disk (a newer pin) is shown unchecked and its token read from gh's file", async () => {
    const fake = setup();
    const child = await showCode(fake);
    child.approve();
    await settle();
    fake.set.pinned = null;
    fake.set.onDisk = false;
    const fresh = createGithubSignIn({ dataDir, team: false, tools: fake.tools, vault: fakeVault(), now: () => clock });
    expect(await fresh.status("owner", { check: true })).toMatchObject({ state: "signed-in", login: "octo-fixture", source: "mausbot", checkedAt: null });
    expect(await fresh.token()).toBe(TOKEN);
    expect(fake.installs()).toBe(0);
  });

  it("parallel checks start gh once", async () => {
    const fake = setup();
    const child = await showCode(fake);
    child.approve();
    await settle();
    await fake.signIn.status("owner");
    const before = fake.calls.filter((call) => call.args[1] === "status").length;
    const answers = await Promise.all([1, 2, 3].map(() => fake.signIn.status("owner", { check: true })));
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(fake.calls.filter((call) => call.args[1] === "status").length).toBe(before + 1);
  });
});

describe("Windows: Credential Manager is one store, so only a positive none lets Start go ahead", () => {
  const entry = ["gh", "github.com", "octo-fixture"].join(":");
  it("refuses while Credential Manager holds a gh entry, or cannot be read, and their gh is not there to say signed out", async () => {
    for (const creds of [[entry], [`gh:_refreshable:github.com:octo-fixture`], null]) {
      const fake = setup({ platform: "win32" });
      fake.set.winCreds = creds;
      await expect(fake.signIn.start("owner")).rejects.toMatchObject({ status: 409 });
      expect(fake.children).toHaveLength(0);
    }
    const empty = setup({ platform: "win32" });
    empty.set.winCreds = [];
    expect((await empty.signIn.start("owner")).state).toBe("installing");
  });

  it("goes ahead when their own gh says signed out, and refuses on their refused (401) sign-in too", async () => {
    const out = setup({ platform: "win32" });
    out.set.personal = "C:\\Program Files\\GitHub CLI\\gh.exe";
    out.set.winCreds = [entry];
    expect((await out.signIn.start("owner")).state).toBe("installing");

    const refused = setup({ platform: "win32" });
    refused.set.personal = "C:\\Program Files\\GitHub CLI\\gh.exe";
    refused.set.personalStatus = ok(fixture("2.103.3/status-json-invalid.stdout.txt"));
    await expect(refused.signIn.start("owner")).rejects.toMatchObject({ status: 409 });
    // Elsewhere a refused sign-in of theirs lets OpenMausBot's own start.
    const linux = setup({ platform: "linux" });
    linux.set.personal = "/usr/bin/gh";
    linux.set.personalStatus = ok(fixture("2.103.3/status-json-invalid.stdout.txt"));
    expect((await linux.signIn.start("owner")).state).toBe("installing");
  });
});
