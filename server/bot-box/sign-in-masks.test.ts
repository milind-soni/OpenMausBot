import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { edgeCertificateStorage } from "../cloud-home-start.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { chatgptAccountHome } from "../drivers/codex-account-home.ts";
import { linkSharedCodexHome } from "../drivers/codex-shared-home.ts";
import { ENGINE_FOLDERS, audienceHome, homedSpawn } from "../engine-homes/layout.ts";
import { BoxRunner } from "./box.ts";
import { boxEnvironment } from "./env.ts";
import { bwrapArgs, planBox, visibleInBox, type BoxRequest, type BoxSetup } from "./plan.ts";
import { signInMasks } from "./sign-in-masks.ts";

// Under the checkout, like a Cloud's /data: the box keeps an engine folder under /tmp its own private one, so a fixture
// data folder there would never have its Codex homes put back.
const checkoutUnderTmp = ["/tmp", "/var/tmp", realpathSync(tmpdir())].some((base) => realpathSync(process.cwd()).startsWith(`${base}/`));
const root = realpathSync(mkdtempSync(join(process.cwd(), ".omb-test-sign-in-masks-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const put = (path: string, text = "x") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

/** A My Cloud volume as engines leave it: every engine signed in once, the edge's certificate, and what bots made in HOME. */
function volume(name: string) {
  const home = join(root, name), dataDir = join(home, ".openmausbot");
  const signIns = {
    claude: join(home, ".claude", ".credentials.json"),
    codex: join(home, ".codex", "auth.json"),
    codexConfig: join(home, ".codex", "config.toml"),
    grok: join(home, ".grok", "auth.json"),
    gemini: join(home, ".gemini", "oauth_creds.json"),
    opencode: join(home, ".local", "share", "opencode", "auth.json"),
    pi: join(home, ".pi", "agent", "auth.json"),
    muse: join(home, ".config", "muse", "auth.json"),
  };
  for (const file of Object.values(signIns)) put(file, `{"token":"${file}"}`);
  const edge = join(edgeCertificateStorage(home), "certificates", "site.key");
  const botFiles = [join(home, ".gitconfig"), join(home, ".ssh", "id_ed25519"), join(home, ".local", "bin", "tool"), join(home, ".claude", "skills", "mine", "SKILL.md")];
  for (const file of [edge, ...botFiles]) put(file);
  const cwd = join(dataDir, "task-workspaces", "bot-a", "thread-1");
  for (const folder of [cwd, join(dataDir, "workspaces", "bot-a")]) mkdirSync(folder, { recursive: true });
  put(join(dataDir, "messages.db"));
  const setup: BoxSetup = { dataDir, home, codeRoots: [], engineRoots: [], bridges: [] };
  const plan = (request: Omit<BoxRequest, "command" | "args" | "cwd"> & { cwd?: string }) => {
    const full: BoxRequest = { command: "engine", args: [], cwd, ...request };
    return planBox(setup, full, full.home ? undefined : signInMasks({ home, dataDir, env: full.env, engine: full.engine }));
  };
  return { home, dataDir, signIns, edge, botFiles, cwd, setup, plan };
}

describe.skipIf(checkoutUnderTmp)("a bot box on a My Cloud keeps only its own engine account's sign-in", () => {
  const cloud = volume("my-cloud");
  const { signIns, home, dataDir } = cloud;

  it("a Claude bot on the default account keeps its login and no other engine's, nor the data folder or the edge's keys", () => {
    const plan = cloud.plan({ env: { HOME: home }, engine: "claudeAgent" });
    expect(visibleInBox(plan, signIns.claude)).toBe("rw");
    for (const other of [signIns.codex, signIns.codexConfig, signIns.grok, signIns.gemini, signIns.opencode, signIns.pi]) expect(visibleInBox(plan, other), other).toBe("none");
    expect(visibleInBox(plan, join(dataDir, "messages.db"))).toBe("none");
    expect(visibleInBox(plan, cloud.edge)).toBe("none");
  });

  it("a Codex bot on the default account keeps that login through MausBot's own Codex home, and no other engine's", () => {
    const own = join(dataDir, "providers", "codex-own", "h1", "codex");
    expect(linkSharedCodexHome(join(home, ".codex"), own, "person")).toBe(true);
    const env = { HOME: home, CODEX_HOME: own };
    const plan = cloud.plan({ env, engine: "codex" });
    expect(visibleInBox(plan, join(own, "auth.json"))).toBe("rw");
    expect(visibleInBox(plan, signIns.codex), "the link's target, which the engine reads and refreshes").toBe("rw");
    expect(visibleInBox(plan, signIns.codexConfig)).toBe("rw");
    for (const other of [signIns.claude, signIns.grok, signIns.gemini]) expect(visibleInBox(plan, other), other).toBe("none");
  });

  it("a Codex bot on an added ChatGPT account keeps only that account's login, never the default account's", () => {
    const work = chatgptAccountHome("chatgpt-work", dataDir), spare = chatgptAccountHome("chatgpt-spare", dataDir);
    for (const account of [work, spare]) {
      linkSharedCodexHome(join(home, ".codex"), account, "own");
      put(join(account, "auth.json"), `{"account":"${account}"}`);
    }
    const env = boxEnvironment({ HOME: home, CODEX_HOME: work, OMB_DATA_DIR: dataDir });
    expect(env).toEqual({ HOME: home, CODEX_HOME: work });
    const plan = cloud.plan({ env, engine: "codex" });
    expect(visibleInBox(plan, join(work, "auth.json"))).toBe("rw");
    expect(visibleInBox(plan, signIns.codex), "the default account's login").toBe("none");
    expect(visibleInBox(plan, join(spare, "auth.json")), "another added account's login").toBe("none");
    expect(visibleInBox(plan, signIns.codexConfig), "the person's Codex setup, linked into the account's home").toBe("rw");
    expect(visibleInBox(plan, signIns.claude)).toBe("none");
  });

  it("a process of no signed-in engine (a shell step, an MCP server) keeps no sign-in at all", () => {
    for (const plan of [cloud.plan({ env: { HOME: home } }), cloud.plan({ env: { HOME: home }, engine: "cursorAgent" })]) {
      for (const file of Object.values(signIns)) expect(visibleInBox(plan, file), file).toBe("none");
    }
  });

  it("follows a link only to the same engine's file in HOME, never to another engine's sign-in a bot planted", () => {
    const planted = volume("planted-cloud");
    rmSync(planted.signIns.pi);
    symlinkSync(planted.signIns.codex, planted.signIns.pi);
    const own = join(planted.dataDir, "providers", "codex-own", "h2", "codex");
    mkdirSync(own, { recursive: true });
    symlinkSync(planted.signIns.claude, join(own, "auth.json"));
    const pi = planted.plan({ env: { HOME: planted.home }, engine: "piAgent" });
    expect(visibleInBox(pi, planted.signIns.codex)).toBe("none");
    const codex = planted.plan({ env: { HOME: planted.home, CODEX_HOME: own }, engine: "codex" });
    expect(visibleInBox(codex, planted.signIns.claude)).toBe("none");
  });

  it("keeps an engine's own login reached through a linked folder, and masks under HOME as the box has it when HOME is a link", () => {
    const linked = volume("linked-cloud");
    const real = join(linked.home, "dotfiles", "config");
    mkdirSync(dirname(real), { recursive: true });
    renameSync(join(linked.home, ".config"), real);
    symlinkSync(real, join(linked.home, ".config"));
    const muse = linked.plan({ env: { HOME: linked.home }, engine: "museCode" });
    expect(visibleInBox(muse, join(real, "muse", "auth.json"))).toBe("rw");
    expect(visibleInBox(linked.plan({ env: { HOME: linked.home }, engine: "claudeAgent" }), join(real, "muse", "auth.json"))).toBe("none");

    const alias = join(root, "home-link");
    symlinkSync(cloud.home, alias);
    const masks = signInMasks({ home: alias, dataDir: join(alias, ".openmausbot"), env: { HOME: alias }, engine: "claudeAgent" });
    expect(masks.masked).toContain(join(alias, ".codex", "auth.json"));
    expect(masks.hidden).toEqual([join(alias, ".omb-edge")]);
    const plan = planBox({ ...cloud.setup, home: alias, dataDir: join(alias, ".openmausbot") }, { command: "claude", args: [], env: { HOME: alias }, engine: "claudeAgent" }, masks);
    expect(visibleInBox(plan, join(alias, ".codex", "auth.json"))).toBe("none");
    expect(visibleInBox(plan, join(alias, ".omb-edge", "caddy", "certificates", "site.key"))).toBe("none");
    expect(visibleInBox(plan, join(alias, ".claude", ".credentials.json"))).toBe("rw");
  });

  it("makes every folder between HOME and a sign-in a mount point, before the data folder's line, so none can be renamed away", () => {
    const plan = cloud.plan({ env: { HOME: home }, engine: "claudeAgent" });
    const binds = plan.mounts.flatMap((mount, index) => (mount.kind === "bind" && mount.source === mount.target ? [[mount.target, index] as const] : []));
    const at = new Map(binds);
    for (const folder of [".claude", ".codex", ".local", ".local/share", ".local/share/opencode", ".config", ".config/muse", ".pi", ".pi/agent"]) expect(at.has(join(home, folder)), folder).toBe(true);
    expect(at.get(join(home, ".local"))!).toBeLessThan(at.get(join(home, ".local", "share"))!);
    const dataLine = plan.mounts.findIndex((mount) => mount.kind === "tmpfs" && mount.target === dataDir);
    expect(at.get(join(home, ".claude"))!).toBeLessThan(dataLine);
    expect(visibleInBox(plan, join(home, ".local", "share", "other-tool", "state"))).toBe("rw");
  });

  it("a Muse bot keeps its login in HOME even where the spawn names another config folder, as its sign-in check does", () => {
    const plan = cloud.plan({ env: { HOME: home, XDG_CONFIG_HOME: join(root, "elsewhere") }, engine: "museCode" });
    expect(visibleInBox(plan, signIns.muse)).toBe("rw");
    expect(visibleInBox(plan, signIns.claude)).toBe("none");
  });

  it("masks stay last, so a path a driver puts back read-write never shows another engine's sign-in", () => {
    const plan = cloud.plan({ env: { HOME: home, CODEX_HOME: join(home, ".codex") }, engine: "claudeAgent", rw: [join(home, ".codex")], ro: [signIns.grok] });
    expect(visibleInBox(plan, signIns.codex)).toBe("none");
    expect(visibleInBox(plan, signIns.grok)).toBe("none");
  });

  it("keeps what bots made in HOME and their own folders where they were", () => {
    const plan = cloud.plan({ env: { HOME: home }, engine: "claudeAgent" });
    for (const file of cloud.botFiles) expect(visibleInBox(plan, file), file).toBe("rw");
    expect(visibleInBox(plan, cloud.cwd)).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-a", "MEMORY.md"))).toBe("rw");
  });

  it("masks only files that are there, so the box never makes an empty sign-in on the server's disk", () => {
    const bare = volume("bare-cloud");
    rmSync(join(bare.home, ".grok"), { recursive: true });
    rmSync(join(bare.home, ".omb-edge"), { recursive: true });
    const args = bwrapArgs(bare.plan({ env: { HOME: bare.home }, engine: "claudeAgent" }));
    expect(args.join(" ")).not.toContain(join(bare.home, ".grok"));
    expect(args.join(" ")).not.toContain(join(bare.home, ".omb-edge"));
    expect(args.join(" ")).toContain(`--ro-bind /dev/null ${bare.signIns.codex}`);
    expect(existsSync(join(bare.home, ".grok"))).toBe(false);
  });

  it("the box runner masks for a spawn in the server's HOME and leaves a Team Cloud audience's home as it plans it", () => {
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge: { socat: null, bridgeScript: "/bridge.js", node: "/node" }, setup: cloud.setup, denyEnv: new Set() });
    const mine = runner.wrap({ command: "claude", args: [], cwd: cloud.cwd, env: { HOME: home }, engine: "claudeAgent" });
    expect(visibleInBox(mine.plan, signIns.codex)).toBe("none");
    expect(visibleInBox(mine.plan, signIns.claude)).toBe("rw");

    const audience = audienceHome(dataDir, "team");
    const homed = homedSpawn({ HOME: home }, { dataDir, serverHome: home, home: audience });
    const team: BoxRequest = { command: "claude", args: [], cwd: cloud.cwd, env: homed.env, home: homed.home, shared: homed.shared };
    const teamPlan = runner.wrap({ ...team, engine: "claudeAgent" }).plan;
    expect(teamPlan).toEqual(planBox(cloud.setup, team));
    expect(teamPlan.mounts.some((mount) => mount.kind === "mask")).toBe(false);
  });

  it("names every engine by a driver that exists, and the edge's certificate folder as the server's alone", () => {
    const kinds = new Set(BUILT_IN_DRIVERS.map((driver) => driver.driverKind));
    for (const folder of ENGINE_FOLDERS) for (const kind of folder.drivers) expect(kinds.has(kind), kind).toBe(true);
    expect(signInMasks({ home, dataDir, env: { HOME: home } }).hidden).toEqual([join(home, ".omb-edge")]);
    expect(readdirSync(home)).toContain(".omb-edge");
  });

  it("every boxed spawn of an engine that signs in in HOME names its engine, or its bots would lose their login", () => {
    const files = ["claude.ts", "claude-keepwarm.ts", "codex.ts", "pi.ts", "muse-code.ts", "acp/core.ts", "acp/browser-auth.ts", "acp/opencode-probe.ts", "acp/opencode-go.ts", "acp/deepseek.ts"];
    let checked = 0;
    for (const file of files) {
      const source = readFileSync(join(import.meta.dirname, "..", "drivers", file), "utf8");
      for (const match of source.matchAll(/\b(?:spawnCli|execCliBoxed)\(/g)) {
        let depth = 0, end = match.index;
        for (; end < source.length; end++) {
          if (source[end] === "(") depth++;
          else if (source[end] === ")" && --depth === 0) break;
        }
        const call = source.slice(match.index, end);
        if (!/"bot"|\bowner\)|box:/.test(call)) continue;
        checked++;
        expect(call, `${file}: ${call.slice(0, 80)}`).toMatch(/\bengine[:,]/);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(12);
    expect(readFileSync(join(import.meta.dirname, "..", "drivers", "claude-keepwarm.ts"), "utf8")).toMatch(/box: \{ ro: \[dir\], engine: "claudeAgent" \}/);
  });
});
