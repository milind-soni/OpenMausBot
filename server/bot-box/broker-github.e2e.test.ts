// A real git, with the box's git env (server/github/git-env.ts), cloning and pushing to "github.com" through the
// broker's github grant, against git's own http-backend standing in for GitHub. The broker listens on a unix socket as
// in a box; a loopback port is bridged to it here as the box's bridge does.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openCredentialBroker, type CredentialBroker } from "./broker.ts";
import { GITHUB_GRANT, githubGrant } from "./broker-github.ts";
import { boxGitEnv } from "../github/git-env.ts";
import { conversationRepos, forgetConversationRepos } from "../github/git-repos.ts";
import { httpBackend, openFakeGithub, type FakeGithub } from "../testing/fake-github-git.ts";

const TOKEN = "ghp_e2eFakeToken0123456789abcdefABCDEF";
const BASIC = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
const backend = process.platform === "win32" ? null : httpBackend();

interface Ran { status: number | null; stdout: string; stderr: string }

// Unix sockets and git's http-backend: Linux and macOS (the box itself runs only on Linux).
describe.skipIf(!backend)("git through the broker's github grant", () => {
  let dir: string, fake: FakeGithub, broker: CredentialBroker, bridge: Server, env: Record<string, string>, brokerToken: string;
  const reported: Array<string | null> = [];

  // Never spawnSync here: the broker and the fake GitHub answer on this process's event loop.
  const git = (args: string[], cwd = dir): Promise<Ran> => new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const bare = (args: string[]) => git(["--git-dir", join(dir, "github", "acme", "widgets.git"), ...args]);
  const receivePosts = () => fake.seen.filter((request) => request.method === "POST" && request.url.endsWith("/git-receive-pack")).length;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "omb-gh-e2e-"));
    mkdirSync(join(dir, "home"));
    const repo = join(dir, "github", "acme", "widgets.git");
    env = {
      PATH: process.env.PATH ?? "", HOME: join(dir, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C", LC_ALL: "C",
      GIT_AUTHOR_NAME: "Bot", GIT_AUTHOR_EMAIL: "bot@example.invalid", GIT_COMMITTER_NAME: "Bot", GIT_COMMITTER_EMAIL: "bot@example.invalid",
    };
    // A repository whose default branch is neither main nor master, so the guard has to learn it.
    expect((await git(["init", "-q", "--bare", "-b", "trunk", repo])).status).toBe(0);
    const seed = join(dir, "seed");
    expect((await git(["init", "-q", "-b", "trunk", seed])).status).toBe(0);
    writeFileSync(join(seed, "README.md"), "widgets\n");
    expect((await git(["add", "."], seed)).status).toBe(0);
    expect((await git(["commit", "-q", "-m", "first"], seed)).status).toBe(0);
    expect((await git(["push", "-q", repo, "trunk", "trunk:refs/heads/old", "trunk:refs/tags/v1"], seed)).status).toBe(0);
    // Another repository the token reaches, which this conversation never cloned.
    expect((await git(["init", "-q", "--bare", "-b", "trunk", join(dir, "github", "acme", "elsewhere.git")])).status).toBe(0);
    expect((await git(["push", "-q", join(dir, "github", "acme", "elsewhere.git"), "trunk"], seed)).status).toBe(0);

    fake = await openFakeGithub({ root: join(dir, "github"), backend: backend!, basic: BASIC });
    broker = await openCredentialBroker({ socketPath: join(dir, "broker.sock") });
    bridge = createServer((client) => {
      const upstream = createConnection(join(dir, "broker.sock"));
      client.pipe(upstream).pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    await new Promise<void>((done) => bridge.listen(0, "127.0.0.1", () => done()));
    const port = (bridge.address() as AddressInfo).port;
    forgetConversationRepos();
    const repos = conversationRepos("thread:t1", [join(dir, "conversation")]);
    mkdirSync(join(dir, "conversation"));
    const grant = githubGrant({ audience: () => "owner", token: async () => TOKEN, reportAuthFailure: (who) => reported.push(who), upstream: fake.url, mayPush: repos.mayPush, fetched: repos.fetched });
    brokerToken = broker.mintForProcess({ botId: "b1", threadId: "t1", grants: { [GITHUB_GRANT]: grant } }).token;
    // What the box sets, plus a credential the bot tried to send itself, which the broker must drop.
    env = { ...env, ...boxGitEnv({ port, token: brokerToken }) };
    env.GIT_CONFIG_PARAMETERS = `${env.GIT_CONFIG_PARAMETERS} 'http.extraheader=Authorization: Bearer bot-made-this-up'`;
  }, 60_000);

  afterAll(async () => {
    await broker?.close();
    await new Promise<void>((done) => bridge ? bridge.close(() => done()) : done());
    await fake?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("clones an https://github.com/ remote, with GitHub's credential added and the bot's own dropped", async () => {
    const cloned = await git(["clone", "-q", "https://github.com/acme/widgets.git", join("conversation", "work")]);
    expect(cloned.status, cloned.stderr).toBe(0);
    expect((await git(["log", "--format=%s"], join(dir, "conversation", "work"))).stdout.trim()).toBe("first");
    expect(fake.seen.length).toBeGreaterThan(0);
    for (const request of fake.seen) {
      expect(request.headers.authorization).toBe(BASIC);
      expect(JSON.stringify(request.headers)).not.toContain("bot-made-this-up");
    }
    // The remote keeps its github.com address; only the broker's token, never GitHub's, is in the box's git env.
    expect((await git(["config", "--get", "remote.origin.url"], join(dir, "conversation", "work"))).stdout.trim()).toBe("https://github.com/acme/widgets.git");
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  }, 60_000);

  it("pushes a new branch", async () => {
    const work = join(dir, "conversation", "work");
    writeFileSync(join(work, "feature.txt"), "a feature\n");
    expect((await git(["add", "."], work)).status).toBe(0);
    expect((await git(["commit", "-q", "-m", "feature"], work)).status).toBe(0);
    const pushed = await git(["push", "origin", "HEAD:refs/heads/bot/feature"], work);
    expect(pushed.status, pushed.stderr).toBe(0);
    expect((await bare(["log", "--format=%s", "-1", "bot/feature"])).stdout.trim()).toBe("feature");
  }, 60_000);

  it("refuses a push to the default branch, with words git shows the bot, and GitHub never sees it", async () => {
    const work = join(dir, "conversation", "work");
    const before = (await bare(["rev-parse", "trunk"])).stdout.trim();
    const posts = receivePosts();
    const pushed = await git(["push", "origin", "HEAD:trunk"], work);
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain("remote rejected");
    expect(pushed.stderr).toContain("push to a new branch");
    expect(pushed.stderr).toMatch(/remote: .*default branch \(trunk\)/);
    expect((await bare(["rev-parse", "trunk"])).stdout.trim()).toBe(before);
    expect(receivePosts()).toBe(posts);
  }, 60_000);

  it("refuses deleting a branch, and a push that mixes a new branch with a refused update applies neither", async () => {
    const work = join(dir, "conversation", "work");
    const deleted = await git(["push", "origin", "--delete", "old"], work);
    expect(deleted.status).not.toBe(0);
    expect(deleted.stderr).toContain("deleting a ref is not allowed here");
    expect((await bare(["rev-parse", "--verify", "-q", "refs/heads/old"])).status).toBe(0);
    const mixed = await git(["push", "origin", "HEAD:refs/heads/bot/other", "HEAD:trunk"], work);
    expect(mixed.status).not.toBe(0);
    expect((await bare(["rev-parse", "--verify", "-q", "refs/heads/bot/other"])).status).not.toBe(0);
  }, 60_000);

  it("streams a push larger than git's post buffer (chunked, after git's probe) to a new branch", async () => {
    const work = join(dir, "conversation", "work");
    writeFileSync(join(work, "blob.bin"), randomBytes(3 * 1024 * 1024));
    expect((await git(["add", "."], work)).status).toBe(0);
    expect((await git(["commit", "-q", "-m", "big"], work)).status).toBe(0);
    const pushed = await git(["-c", "http.postBuffer=65536", "push", "origin", "HEAD:refs/heads/bot/big"], work);
    expect(pushed.status, pushed.stderr).toBe(0);
    expect((await bare(["log", "--format=%s", "-1", "bot/big"])).stdout.trim()).toBe("big");
  }, 60_000);

  it("never writes the broker token into git's records: a merge, FETCH_HEAD, remotes, a failed fetch's error, any file of the clone", async () => {
    const work = join(dir, "conversation", "work");
    // Someone else moves trunk on, so a pull makes a merge commit whose message names where it fetched from.
    const other = join(dir, "other");
    expect((await git(["clone", "-q", join(dir, "github", "acme", "widgets.git"), other])).status).toBe(0);
    writeFileSync(join(other, "upstream.txt"), "moved on\n");
    expect((await git(["add", "."], other)).status).toBe(0);
    expect((await git(["commit", "-q", "-m", "upstream change"], other)).status).toBe(0);
    expect((await git(["push", "-q", "origin", "trunk"], other)).status).toBe(0);
    const pulled = await git(["pull", "--no-rebase", "--no-edit", "origin", "trunk"], work);
    expect(pulled.status, pulled.stderr).toBe(0);
    const merge = (await git(["log", "-1", "--format=%B"], work)).stdout;
    expect(merge).toMatch(/Merge branch 'trunk' of \S+\/acme\/widgets/);
    const failed = await git(["fetch", "https://github.com/acme/no-such-repo.git"], work);
    expect(failed.status).not.toBe(0);
    const remotes = (await git(["remote", "-v"], work)).stdout;
    // `remote -v` shows the address git uses after insteadOf: the broker's, with no token in it.
    expect(remotes).toContain("/g/github/acme/widgets.git");
    const texts = [merge, failed.stderr, failed.stdout, remotes, pulled.stderr, pulled.stdout];
    const files = (folder: string): string[] => readdirSync(folder).flatMap((name) => {
      const path = join(folder, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
    for (const file of files(work)) texts.push(readFileSync(file, "latin1"));
    for (const text of texts) {
      expect(text).not.toContain(brokerToken);
      expect(text).not.toContain("omb_t0_");
      expect(text).not.toContain(TOKEN);
    }
  }, 60_000);

  it("pushes a new tag but refuses moving one, and refuses refs outside branches and tags", async () => {
    const work = join(dir, "conversation", "work");
    expect((await git(["tag", "v2"], work)).status).toBe(0);
    const tagged = await git(["push", "origin", "refs/tags/v2"], work);
    expect(tagged.status, tagged.stderr).toBe(0);
    expect((await git(["tag", "-f", "v1"], work)).status).toBe(0);
    const moved = await git(["push", "--force", "origin", "refs/tags/v1"], work);
    expect(moved.status).not.toBe(0);
    expect(moved.stderr).toContain("moving a tag is not allowed here");
    const pull = await git(["push", "origin", "HEAD:refs/pull/1/head"], work);
    expect(pull.status).not.toBe(0);
    expect(pull.stderr).toContain("only branches and new tags may be pushed here");
  }, 60_000);

  it("refuses a push to a repository this conversation never cloned or fetched", async () => {
    const work = join(dir, "conversation", "work");
    const pushed = await git(["push", "https://github.com/acme/elsewhere.git", "HEAD:refs/heads/bot/sneak"], work);
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain("acme/elsewhere is not a repository this conversation has cloned or fetched");
    expect((await git(["--git-dir", join(dir, "github", "acme", "elsewhere.git"), "rev-parse", "--verify", "-q", "refs/heads/bot/sneak"])).status).not.toBe(0);
  }, 60_000);

  it("keeps a credential helper of another git host working; the broker's address gets none", async () => {
    // The bot's own helper, in its own global git config as `git config --global credential.helper` would put it.
    const global = join(dir, "home", "own.gitconfig");
    writeFileSync(global, "[credential]\n\thelper = \"!f() { echo username=me; echo password=gitlab-secret; }; f\"\n");
    const fill = (host: string, protocol = "https") => new Promise<string>((resolve) => {
      const child = spawn("git", ["credential", "fill"], { env: { ...env, GIT_CONFIG_GLOBAL: global }, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", () => resolve(out));
      child.stdin.end(`protocol=${protocol}\nhost=${host}\n\n`);
    });
    expect(await fill("gitlab.example")).toContain("password=gitlab-secret");
    const port = (bridge.address() as AddressInfo).port;
    expect(await fill(`127.0.0.1:${port}`, "http")).not.toContain("gitlab-secret");
  }, 60_000);

  it("takes the SSH forms of a github.com remote over the same HTTPS way", async () => {
    for (const remote of ["git@github.com:acme/widgets.git", "ssh://git@github.com/acme/widgets.git"]) {
      const listed = await git(["ls-remote", remote]);
      expect(listed.status, listed.stderr).toBe(0);
      expect(listed.stdout).toContain("refs/heads/trunk");
    }
    expect(reported).toEqual([]);
  }, 60_000);
});
