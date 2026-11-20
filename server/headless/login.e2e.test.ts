import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../../scripts/control-omb.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { runHeadless, type HeadlessOptions } from "./main.ts";
import type { HeadlessIo } from "./output.ts";
import type { SecurityRunner } from "./saved-servers.ts";

/** macOS `security` as a map: no real keychain is touched. */
function fakeKeychain(): SecurityRunner {
  const items = new Map<string, string>();
  return (args, stdin) => {
    if (args[0] === "-i") {
      const match = /-s "([^"]+)" -a "([^"]+)" -l "[^"]*" -w "([^"]+)"/.exec(stdin ?? "");
      if (match) items.set(`${match[1]}/${match[2]}`, match[3]!);
      return { status: match ? 0 : 1, stdout: "" };
    }
    const key = `${args[args.indexOf("-s") + 1]}/${args[args.indexOf("-a") + 1]}`;
    if (args[0] === "find-generic-password") return items.has(key) ? { status: 0, stdout: `${items.get(key)}\n` } : { status: 44, stdout: "" };
    return { status: items.delete(key) ? 0 : 44, stdout: "" };
  };
}

describe("openmausbot login, then status, bots, stop and threads against the desktop app's own server", () => {
  let fixture: VerificationServer;
  const owner = randomBytes(32).toString("base64url");
  const home = mkdtempSync(join(tmpdir(), "omb-cli-home-"));
  const security = fakeKeychain();
  const asApp = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", "x-openmausbot-desktop-owner": owner, origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return await response.json() as Record<string, any>;
  };
  const cli = async (argv: string[], options: Partial<HeadlessOptions> = {}) => {
    const out: string[] = [], err: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
    const code = await runHeadless(argv, { io, env: { HOME: home }, platform: "darwin", security, interactive: false, openBrowser: async () => false, ...options });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  beforeAll(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => realFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": owner } });
    try {
      fixture = await launchVerificationServer({ ...process.env, OMB_TEST_DESKTOP_OWNER_TOKEN: owner });
    } finally {
      globalThis.fetch = realFetch;
    }
    for (const [name, section] of [["QA Tester 1", "QA"], ["QA Tester 2", "QA"], ["Support Lead", "Support"]]) {
      await asApp("POST", "/api/bots", { name, section, useDefaults: false, requireAvailableModel: false });
    }
  });
  afterAll(async () => {
    await fixture?.close();
    removeTempDir(home);
  });

  it("signs in only after Allow in the app, then acts as the person; a bot's shell never uses that sign-in", async () => {
    const before = await cli(["bots", "delete", "QA Tester 1", "--url", fixture.info.url, "--yes"]);
    expect(before.code).toBe(4);
    expect(before.out).toContain("hint: sign in once with `openmausbot login`");

    let shown = "";
    const approving = (async () => {
      for (let tries = 0; tries < 100; tries++) {
        const waiting = (await asApp("GET", "/api/auth/cli-login")).requests ?? [];
        if (waiting.length) {
          shown = waiting[0].code;
          return asApp("POST", `/api/auth/cli-login/${waiting[0].id}/allow`, {});
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("no sign-in request arrived");
    })();
    const login = await cli(["login", fixture.info.url, "--json"]);
    await approving;
    expect(login.code).toBe(0);
    expect(login.err).toContain(shown);
    expect(login.err).toContain("MausBot is asking you to allow this terminal");
    const signedIn = JSON.parse(login.out);
    expect(signedIn).toMatchObject({ ok: true, storedIn: "keychain", session: { scopes: ["admin", "client"] } });
    expect(login.out).not.toMatch(/omb_sess_/);

    const whoami = await cli(["whoami"]);
    expect(whoami).toMatchObject({ code: 0, out: expect.stringContaining("full control") });

    const status = await cli(["status", "--json"]);
    expect(status.code).toBe(0);
    const statusBody = JSON.parse(status.out);
    expect(statusBody.bots.map((bot: { name: string }) => bot.name)).toEqual(expect.arrayContaining(["QA Tester 1", "QA Tester 2", "Support Lead"]));
    expect(statusBody.bots.every((bot: { state: string }) => bot.state === "idle")).toBe(true);
    expect((await cli(["status"])).out).toMatch(/BOT\s+STATE\s+COMPUTER\s+TEAM\s+ID/);

    const plan = await cli(["bots", "delete", "--team", "qa", "--dry-run"]);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("Would delete 2 bots");
    expect(plan.out).toContain("QA Tester 1");
    expect(plan.out).toContain("Nothing was changed (--dry-run).");
    const unconfirmed = await cli(["bots", "delete", "--team", "QA"]);
    expect(unconfirmed).toMatchObject({ code: 2, err: expect.stringContaining("add --yes") });
    expect((await cli(["bots", "delete", "--team", "QA"], { interactive: true, confirm: async () => false })).code).toBe(1);

    // A real turn's environment, as the engine (and so a bot's shell) got it from the server, with the person's HOME.
    expect((await cli(["send", "Support Lead", "hello"])).code).toBe(0);
    expect((await cli(["wait", "Support Lead", "--timeout", "60"])).code).toBe(0);
    const turnEnv = (JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { env: NodeJS.ProcessEnv }).env;
    const botShell = { env: { ...turnEnv, HOME: home } };
    const refused = await cli(["bots", "delete", "QA Tester 1", "--yes"], botShell);
    expect(refused.code).toBe(5);
    expect(refused.out).toContain("your own terminal");
    expect((await cli(["login"], botShell)).code).toBe(5);
    expect((await cli(["whoami"], botShell)).out).toContain("acting as the bot");

    const deleted = await cli(["bots", "delete", "--team", "QA", "--yes", "--json"]);
    expect(deleted.code).toBe(0);
    expect(JSON.parse(deleted.out)).toMatchObject({ ok: true, deleted: 2 });
    expect((await cli(["bots", "get", "QA Tester 1"])).code).toBe(7);

    const stopAll = await cli(["stop", "--all", "--yes"]);
    expect(stopAll).toMatchObject({ code: 0, out: expect.stringContaining("Nothing is paused") });

    expect((await cli(["bots", "pause", "Support Lead"])).code).toBe(0);
    expect(JSON.parse((await cli(["status", "--json"])).out).bots.find((bot: { name: string }) => bot.name === "Support Lead").state).toBe("paused");
    expect((await cli(["bots", "resume", "Support Lead"])).code).toBe(0);

    const threads = await cli(["threads", "list", "Support Lead", "--json"]);
    expect(JSON.parse(threads.out).threads).toHaveLength(1);
    const cleared = await cli(["threads", "clear", "Support Lead", "--yes", "--json"]);
    expect(cleared.code).toBe(0);
    expect(JSON.parse(cleared.out).deleted).toHaveLength(1);

    expect((await cli(["computers", "start", "Support Lead"])).code).toBe(6);

    const out = await cli(["logout"]);
    expect(out).toMatchObject({ code: 0, out: expect.stringContaining("Signed out") });
    expect((await cli(["bots", "delete", "Support Lead", "--url", fixture.info.url, "--yes"])).code).toBe(4);
  });
});

describe("openmausbot login against a server started with openmausbot serve", () => {
  let fixture: VerificationServer;
  const home = mkdtempSync(join(tmpdir(), "omb-cli-serve-home-"));
  const cli = async (argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
    const code = await runHeadless(argv, { io, env: { HOME: home }, platform: "linux", interactive: false, openBrowser: async () => false });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  beforeAll(async () => { fixture = await launchVerificationServer(); });
  afterAll(async () => {
    await fixture?.close();
    removeTempDir(home);
  });

  it("signs in with no card, since a command here is that server's owner, and a chat-only sign-in cannot stop every bot", async () => {
    const login = await cli(["login", fixture.info.url, "--scope", "chat", "--name", "box", "--json"]);
    expect(login.code).toBe(0);
    expect(login.err).toBe("");
    expect(JSON.parse(login.out)).toMatchObject({ name: "box", storedIn: "file", session: { scopes: ["client"] } });
    expect((await cli(["whoami"])).out).toContain("chat only");
    const stop = await cli(["stop", "--all", "--yes"]);
    expect(stop.code).toBe(5);
    expect(stop.err).toContain("chat only");
    expect((await cli(["servers"])).out).toContain("* box");
  });
});
