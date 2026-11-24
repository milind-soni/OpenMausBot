import { afterEach, describe, expect, it } from "vitest";

import { BOX_BROKER_PORT, BOX_EGRESS_PORT, BoxRunner } from "../bot-box/box.ts";
import type { BrokerGrant } from "../bot-box/broker.ts";
import { engineInstallRoots } from "../engine-roots.ts";
import { gitAudience, provideGitAudience } from "./git-access.ts";
import { GITHUB_REMOTE_FORMS, boxGitEnv, gitConfigParameters, shellQuote } from "./git-env.ts";
import { provideGithubSignIn } from "./token.ts";

const TOKEN = "ghp_boxPlanFakeToken0123456789abcdefABCD";
const bridge = { socat: "/usr/bin/socat", bridgeScript: "/app/dist-server/bot-box/box-bridge.js", node: "/usr/local/bin/node" };
const setup = {
  dataDir: "/data/.openmausbot", home: "/data", codeRoots: ["/app"], engineRoots: engineInstallRoots("/data/.openmausbot"),
  bridges: [{ name: "egress", port: BOX_EGRESS_PORT, socket: "/data/.openmausbot/box/egress.sock" }, { name: "broker", port: BOX_BROKER_PORT, socket: "/data/.openmausbot/box/broker.sock" }],
};

/** A broker that records what each token was minted with. */
function fakeBroker() {
  const minted: Array<{ token: string; threadId: string | null; grants: Record<string, BrokerGrant> }> = [];
  const revoked: string[] = [];
  let n = 0;
  return {
    minted, revoked,
    broker: {
      port: BOX_BROKER_PORT,
      mintForProcess(input: { threadId?: string | null; grants: Record<string, BrokerGrant> }) {
        const token = `omb_t0_${String(++n).padStart(48, "0")}`;
        minted.push({ token, threadId: input.threadId ?? null, grants: input.grants });
        return { token };
      },
      revoke(token: string) { revoked.push(token); },
    },
  };
}

function signIn(signedIn: (audience: string | null | undefined) => boolean) {
  provideGithubSignIn({ token: async () => TOKEN, reportAuthFailure: () => {}, signedIn });
}

const wrapIn = (runner: BoxRunner, cwd: string, extra: Record<string, unknown> = {}) =>
  runner.wrap({ command: "/usr/local/bin/claude", args: ["-p"], cwd, env: { PATH: "/usr/bin", HOME: "/data", GIT_CONFIG_PARAMETERS: "'core.hookspath=/tmp/x'", GIT_CONFIG_COUNT: "1" }, ...extra });

describe("a boxed bot's git", () => {
  afterEach(() => {
    provideGithubSignIn(null);
    provideGitAudience(null);
  });

  it("with a sign-in: every GitHub remote form goes to the broker under the process's token, and GitHub's token is nowhere in the box", () => {
    signIn(() => true);
    const { broker, minted } = fakeBroker();
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set(), broker });
    const wrapped = wrapIn(runner, "/data/.openmausbot/task-workspaces/b1/t1");
    const process = minted.at(-1)!;
    expect(wrapped.token).toBe(process.token);
    expect(Object.keys(process.grants)).toEqual(["github"]);
    expect(process.grants.github!.upstream).toBe("https://github.com");
    expect(process.grants.github!.headers).toEqual({});
    const origin = `http://127.0.0.1:${BOX_BROKER_PORT}`;
    // The server's own git settings never pass the allow-list; only ours are there.
    expect(wrapped.env.GIT_CONFIG_PARAMETERS).toBe(boxGitEnv({ port: BOX_BROKER_PORT, token: process.token }).GIT_CONFIG_PARAMETERS);
    expect(wrapped.env.GIT_CONFIG_COUNT).toBeUndefined();
    // The remote's address carries no token: git writes that address down (merge messages, FETCH_HEAD, errors).
    for (const form of GITHUB_REMOTE_FORMS) expect(wrapped.env.GIT_CONFIG_PARAMETERS).toContain(shellQuote(`url.${origin}/g/github/.insteadof=${form}`));
    expect(wrapped.env.GIT_CONFIG_PARAMETERS).not.toMatch(/insteadof=[^']*omb_t0_/);
    expect(wrapped.env.GIT_CONFIG_PARAMETERS).not.toContain(`/b/${process.token}`);
    // The token goes in a header git sends only to the broker's address, and no helper is asked for that address alone.
    expect(wrapped.env.GIT_CONFIG_PARAMETERS).toContain(shellQuote(`http.${origin}/.extraheader=x-omb-broker: ${process.token}`));
    expect(wrapped.env.GIT_CONFIG_PARAMETERS).toContain(shellQuote(`credential.${origin}.helper=`));
    expect(wrapped.env.GIT_CONFIG_PARAMETERS).not.toContain("'credential.helper=");
    expect(wrapped.env.GIT_TERMINAL_PROMPT).toBe("0");
    // git reaches the broker's loopback port directly, not through the box's network gate.
    expect(wrapped.env.HTTPS_PROXY).toBe(`http://127.0.0.1:${BOX_EGRESS_PORT}`);
    for (const name of ["NO_PROXY", "no_proxy"]) expect(wrapped.env[name]!.split(",")).toContain("127.0.0.1");
    expect(JSON.stringify([wrapped.env, wrapped.args, wrapped.command])).not.toContain(TOKEN);
  });

  it("survives each engine's shell: no name holds KEY, SECRET or TOKEN, which Codex's default shell policy drops", () => {
    for (const name of Object.keys(boxGitEnv({ port: 18080, token: `omb_t0_${"a".repeat(48)}` }))) expect(name).not.toMatch(/KEY|SECRET|TOKEN/i);
  });

  it("with no sign-in: nothing changes, no token is minted for git and no git setting is added", () => {
    signIn(() => false);
    const { broker, minted, revoked } = fakeBroker();
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set(), broker });
    const wrapped = wrapIn(runner, "/data/.openmausbot/task-workspaces/b1/t1");
    expect(wrapped.token).toBeNull();
    expect(minted.map((entry) => entry.token)).toEqual(revoked);
    expect(Object.keys(wrapped.env).filter((name) => name.startsWith("GIT_"))).toEqual([]);
    provideGithubSignIn(null);
    expect(Object.keys(wrapIn(runner, "/data/.openmausbot/task-workspaces/b1/t1").env).filter((name) => name.startsWith("GIT_"))).toEqual([]);
  });

  it("shares the one per-process token with a provider key the broker took over", () => {
    signIn(() => true);
    const { broker, minted } = fakeBroker();
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set(), broker });
    const wrapped = runner.wrap({ command: "/usr/local/bin/claude", args: [], cwd: "/data/.openmausbot/task-workspaces/b1/t1", env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-real" } });
    const process = minted.at(-1)!;
    expect(Object.keys(process.grants).sort()).toEqual(["anthropic", "github"]);
    expect(wrapped.env.ANTHROPIC_API_KEY).toBe(process.token);
    expect(wrapped.env.GIT_CONFIG_PARAMETERS).toContain(`x-omb-broker: ${process.token}`);
  });

  it("on a Team Cloud: the member's own conversation gets that member's sign-in; a room's, the team's and a shared process get none", () => {
    const asked: Array<string | null | undefined> = [];
    signIn((audience) => { asked.push(audience); return audience === "p_aaaaaaaaaaaaaaaaaaaaaa"; });
    provideGitAudience((threadId) => (threadId === "mine" ? "p_aaaaaaaaaaaaaaaaaaaaaa" : null));
    const { broker, minted } = fakeBroker();
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set(), broker });
    expect(wrapIn(runner, "/data/.openmausbot/task-workspaces/b1/mine").env.GIT_CONFIG_PARAMETERS).toContain("/github/");
    expect(minted.at(-1)!.grants.github).toBeDefined();
    expect(wrapIn(runner, "/data/.openmausbot/task-workspaces/b1/room").env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(wrapIn(runner, "/data/.openmausbot/task-workspaces/b1/mine", { botThreads: true }).env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(asked).toEqual(["p_aaaaaaaaaaaaaaaaaaaaaa"]);
    expect(gitAudience(null)).toBeNull();
    provideGitAudience(null);
    expect(gitAudience(null)).toBe("owner");
    expect(gitAudience("any")).toBe("owner");
  });
});

describe("git settings in the environment", () => {
  it("are quoted as git quotes them and added after what is there", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(gitConfigParameters([["a.b", "c d"]], "'x.y=z'")).toBe("'x.y=z' 'a.b=c d'");
    expect(gitConfigParameters([["a.b", ""]])).toBe("'a.b='");
    expect(() => gitConfigParameters([["a=b", "c"]])).toThrow();
    expect(() => gitConfigParameters([["a.b", "c\nd"]])).toThrow();
  });
});
