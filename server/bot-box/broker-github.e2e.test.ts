// A real git, with the box's git env (server/github/git-env.ts), cloning and pushing to "github.com" through the
// broker's github grant, against git's own http-backend standing in for GitHub. The broker listens on a unix socket as
// in a box; a loopback port is bridged to it here as the box's bridge does.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { brokerUrl, openCredentialBroker, type CredentialBroker } from "./broker.ts";
import { GITHUB_GRANT, githubGrant } from "./broker-github.ts";
import { boxGitEnv } from "../github/git-env.ts";
import { httpBackend, openFakeGithub, type FakeGithub } from "../testing/fake-github-git.ts";

const TOKEN = "ghp_e2eFakeToken0123456789abcdefABCDEF";
const BASIC = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
const backend = process.platform === "win32" ? null : httpBackend();

interface Ran { status: number | null; stdout: string; stderr: string }

// Unix sockets and git's http-backend: Linux and macOS (the box itself runs only on Linux).
describe.skipIf(!backend)("git through the broker's github grant", () => {
  let dir: string, fake: FakeGithub, broker: CredentialBroker, bridge: Server, env: Record<string, string>;
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
    expect((await git(["push", "-q", repo, "trunk", "trunk:refs/heads/old"], seed)).status).toBe(0);

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
    const grant = githubGrant({ audience: () => "owner", token: async () => TOKEN, reportAuthFailure: (who) => reported.push(who), upstream: fake.url });
    const { token } = broker.mintForProcess({ botId: "b1", threadId: "t1", grants: { [GITHUB_GRANT]: grant } });
    // What the box sets, plus a credential the bot tried to send itself, which the broker must drop.
    env = { ...env, ...boxGitEnv(brokerUrl(port, token, GITHUB_GRANT)) };
    env.GIT_CONFIG_PARAMETERS = `${env.GIT_CONFIG_PARAMETERS} 'http.extraheader=Authorization: Bearer bot-made-this-up'`;
  }, 60_000);

  afterAll(async () => {
    await broker?.close();
    await new Promise<void>((done) => bridge ? bridge.close(() => done()) : done());
    await fake?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("clones an https://github.com/ remote, with GitHub's credential added and the bot's own dropped", async () => {
    const cloned = await git(["clone", "-q", "https://github.com/acme/widgets.git", "work"]);
    expect(cloned.status, cloned.stderr).toBe(0);
    expect((await git(["log", "--format=%s"], join(dir, "work"))).stdout.trim()).toBe("first");
    expect(fake.seen.length).toBeGreaterThan(0);
    for (const request of fake.seen) {
      expect(request.headers.authorization).toBe(BASIC);
      expect(JSON.stringify(request.headers)).not.toContain("bot-made-this-up");
    }
    // The remote keeps its github.com address; only the broker's token, never GitHub's, is in the box's git env.
    expect((await git(["config", "--get", "remote.origin.url"], join(dir, "work"))).stdout.trim()).toBe("https://github.com/acme/widgets.git");
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  }, 60_000);

  it("pushes a new branch", async () => {
    const work = join(dir, "work");
    writeFileSync(join(work, "feature.txt"), "a feature\n");
    expect((await git(["add", "."], work)).status).toBe(0);
    expect((await git(["commit", "-q", "-m", "feature"], work)).status).toBe(0);
    const pushed = await git(["push", "origin", "HEAD:refs/heads/bot/feature"], work);
    expect(pushed.status, pushed.stderr).toBe(0);
    expect((await bare(["log", "--format=%s", "-1", "bot/feature"])).stdout.trim()).toBe("feature");
  }, 60_000);

  it("refuses a push to the default branch, with words git shows the bot, and GitHub never sees it", async () => {
    const work = join(dir, "work");
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
    const work = join(dir, "work");
    const deleted = await git(["push", "origin", "--delete", "old"], work);
    expect(deleted.status).not.toBe(0);
    expect(deleted.stderr).toContain("deleting a ref is not allowed here");
    expect((await bare(["rev-parse", "--verify", "-q", "refs/heads/old"])).status).toBe(0);
    const mixed = await git(["push", "origin", "HEAD:refs/heads/bot/other", "HEAD:trunk"], work);
    expect(mixed.status).not.toBe(0);
    expect((await bare(["rev-parse", "--verify", "-q", "refs/heads/bot/other"])).status).not.toBe(0);
  }, 60_000);

  it("streams a push larger than git's post buffer (chunked, after git's probe) to a new branch", async () => {
    const work = join(dir, "work");
    writeFileSync(join(work, "blob.bin"), randomBytes(3 * 1024 * 1024));
    expect((await git(["add", "."], work)).status).toBe(0);
    expect((await git(["commit", "-q", "-m", "big"], work)).status).toBe(0);
    const pushed = await git(["-c", "http.postBuffer=65536", "push", "origin", "HEAD:refs/heads/bot/big"], work);
    expect(pushed.status, pushed.stderr).toBe(0);
    expect((await bare(["log", "--format=%s", "-1", "bot/big"])).stdout.trim()).toBe("big");
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
