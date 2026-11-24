import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { GIT_CREDENTIAL_TTL_MS, createGitCredentialRoutes, resetGitCredentials, unboxedGitCredential } from "./git-credential.ts";
import { GIT_CREDENTIAL_HEADER, GIT_CREDENTIAL_PATH, unboxedGitEnv } from "./git-env.ts";
import { provideGithubSignIn } from "./token.ts";

const TOKEN = "ghp_helperFakeToken0123456789abcdefABCD";
const loopback = { kind: "loopback", scopes: [] } as unknown as RequestAuth;

/** The route behind a plain server, with `auth` standing in for the auth gate's verdict. */
async function serve(route: ReturnType<typeof createGitCredentialRoutes>, auth: RequestAuth = loopback): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void route({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody }).then((out) => { if (!res.headersSent) res.writeHead(404).end(); return out; });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  return { server, port: (server.address() as AddressInfo).port };
}

describe("the unboxed credential helper", () => {
  let server: Server | null = null, dir: string | null = null, clock = 1_800_000_000_000;
  afterEach(async () => {
    resetGitCredentials();
    provideGithubSignIn(null);
    await new Promise<void>((done) => server ? server.close(() => done()) : done());
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("is added only where the route is served, enabled and signed in, after the person's own git settings", () => {
    const env = { PATH: "/usr/bin", GIT_CONFIG_PARAMETERS: "'user.name=Me'" };
    expect(unboxedGitCredential(env)).toBeNull();
    let enabled = false;
    createGitCredentialRoutes({ port: 8799, enabled: () => enabled });
    provideGithubSignIn({ token: async () => TOKEN, reportAuthFailure: () => {}, signedIn: (who) => who === "owner" });
    expect(unboxedGitCredential(env)).toBeNull();
    enabled = true;
    const added = unboxedGitCredential(env)!;
    expect(added.env.GIT_CONFIG_PARAMETERS!.startsWith("'user.name=Me' 'credential.https://github.com.helper=!f() {")).toBe(true);
    expect(added.env.PATH).toBe("/usr/bin");
    expect(JSON.stringify(added.env)).not.toContain(TOKEN);
    provideGithubSignIn({ token: async () => TOKEN, reportAuthFailure: () => {}, signedIn: () => false });
    expect(unboxedGitCredential(env)).toBeNull();
  });

  it("answers git's credential lines to the loopback with a live secret only, and nothing once the process exited", async () => {
    createGitCredentialRoutes({ port: 1, enabled: () => true, now: () => clock });
    provideGithubSignIn({ token: async () => TOKEN, reportAuthFailure: () => {}, signedIn: () => true });
    const route = createGitCredentialRoutes({ port: 1, enabled: () => true, now: () => clock });
    ({ server } = await serve(route));
    const port = (server.address() as AddressInfo).port;
    const added = unboxedGitCredential({})!;
    const secret = /x-omb-git-credential: ([A-Za-z0-9_-]+)/.exec(added.env.GIT_CONFIG_PARAMETERS!)![1]!;
    const ask = (headers: Record<string, string>, method = "GET") => fetch(`http://127.0.0.1:${port}${GIT_CREDENTIAL_PATH}`, { method, headers });
    const good = await ask({ [GIT_CREDENTIAL_HEADER]: secret });
    expect(good.status).toBe(200);
    expect(good.headers.get("cache-control")).toBe("no-store");
    expect(await good.text()).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    expect((await ask({})).status).toBe(403);
    expect((await ask({ [GIT_CREDENTIAL_HEADER]: `${secret.slice(0, -1)}x` })).status).toBe(403);
    expect((await ask({ [GIT_CREDENTIAL_HEADER]: secret }, "POST")).status).toBe(403);
    clock += GIT_CREDENTIAL_TTL_MS;
    expect((await ask({ [GIT_CREDENTIAL_HEADER]: secret })).status).toBe(403);
    clock -= GIT_CREDENTIAL_TTL_MS;
    added.release();
    expect((await ask({ [GIT_CREDENTIAL_HEADER]: secret })).status).toBe(403);
  });

  it("never answers a session or a shared server's bot shells, and nothing for a signed-out server", async () => {
    provideGithubSignIn({ token: async () => null, reportAuthFailure: () => {}, signedIn: () => true });
    const route = createGitCredentialRoutes({ port: 1, enabled: () => true });
    const added = unboxedGitCredential({})!;
    const secret = /x-omb-git-credential: ([A-Za-z0-9_-]+)/.exec(added.env.GIT_CONFIG_PARAMETERS!)![1]!;
    for (const auth of [{ kind: "session", scopes: ["admin"] }, { kind: "loopback", scopes: [], trust: "service" }]) {
      ({ server } = await serve(route, auth as unknown as RequestAuth));
      expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${GIT_CREDENTIAL_PATH}`, { headers: { [GIT_CREDENTIAL_HEADER]: secret } })).status).toBe(403);
      await new Promise<void>((done) => server!.close(() => done()));
    }
    ({ server } = await serve(route));
    expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${GIT_CREDENTIAL_PATH}`, { headers: { [GIT_CREDENTIAL_HEADER]: secret } })).status).toBe(204);
  });

  it("refuses a secret or port that is not one", () => {
    expect(() => unboxedGitEnv({ port: 8799, secret: "a b" })).toThrow();
    expect(() => unboxedGitEnv({ port: 0, secret: "a".repeat(24) })).toThrow();
  });

  // The helper as git runs it: `git credential fill` with the spawn's environment, through git's shell and curl.
  const haveTools = spawnSync("git", ["--version"]).status === 0 && spawnSync("curl", ["--version"]).status === 0;
  it.skipIf(!haveTools)("gives git the token for github.com, after a helper of the person's own that has nothing, and nothing for another host", async () => {
    dir = mkdtempSync(join(tmpdir(), "omb-git-helper-"));
    provideGithubSignIn({ token: async () => TOKEN, reportAuthFailure: () => {}, signedIn: () => true });
    const route = createGitCredentialRoutes({ port: 1, enabled: () => true });
    ({ server } = await serve(route));
    createGitCredentialRoutes({ port: (server.address() as AddressInfo).port, enabled: () => true });
    const base = { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "nothing"), GIT_TERMINAL_PROMPT: "0", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    const added = unboxedGitCredential({ ...base, GIT_CONFIG_PARAMETERS: "'credential.helper=!true'" })!;
    const fill = (host: string, env: Record<string, string | undefined>) => new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn("git", ["credential", "fill"], { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", (status) => resolve({ status, out }));
      child.stdin.end(`protocol=https\nhost=${host}\n\n`);
    });
    const github = await fill("github.com", added.env);
    expect(github.status).toBe(0);
    expect(github.out).toContain("username=x-access-token\n");
    expect(github.out).toContain(`password=${TOKEN}\n`);
    expect((await fill("gitlab.example", added.env)).status).not.toBe(0);
    added.release();
  });

  it.skipIf(!haveTools)("leaves the person's own working credentials in charge: their helper answers and ours is never asked", async () => {
    dir = mkdtempSync(join(tmpdir(), "omb-git-helper-"));
    provideGithubSignIn({ token: async () => TOKEN, reportAuthFailure: () => {}, signedIn: () => true });
    let asked = 0;
    const counted = createGitCredentialRoutes({ port: 1, enabled: () => true });
    ({ server } = await serve(async (ctx) => { asked += 1; return counted(ctx); }));
    createGitCredentialRoutes({ port: (server.address() as AddressInfo).port, enabled: () => true });
    const own = "'credential.helper=!f() { echo username=me; echo password=mine; }; f'";
    const added = unboxedGitCredential({ PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "nothing"), GIT_CONFIG_PARAMETERS: own, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) })!;
    const out = await new Promise<string>((resolve) => {
      const child = spawn("git", ["credential", "fill"], { env: added.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "ignore"] });
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.on("close", () => resolve(text));
      child.stdin.end("protocol=https\nhost=github.com\n\n");
    });
    expect(out).toContain("password=mine");
    expect(asked).toBe(0);
    added.release();
  });
});
