// While the bot box is on, a boxed bot can write the server's HOME. These run the real npm and git the server runs
// outside the box, against a HOME holding the config files a bot could leave there, and check that neither acts on them.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { npmEnvironment, runNpm } from "../engine-install.ts";
import { gitInvocation } from "../lent-clone.ts";

const has = (command: string) => { try { execFileSync(command, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } };
const posix = process.platform !== "win32";

describe.skipIf(!posix)("the server's own npm and git, with a HOME a bot wrote", () => {
  let dir: string, home: string, data: string, marker: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "omb-hostile-")));
    home = join(dir, "home");
    data = join(dir, "data");
    marker = join(dir, "escaped");
    mkdirSync(home, { recursive: true });
    mkdirSync(data, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A script that records that it ran, which is what a bot would put in a config file. */
  function hostileScript(): string {
    const script = join(home, ".local", "bin", "hostile");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> "${marker}"\nexec /bin/sh "$@"\n`);
    chmodSync(script, 0o755);
    return script;
  }

  it.skipIf(!has("npm"))("npm ignores a .npmrc in HOME, and the package's own install script still runs", async () => {
    writeFileSync(join(home, ".npmrc"), `script-shell=${hostileScript()}\n`);
    const pkg = join(dir, "pkg");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "bin", "omb-hostile-check"), "#!/usr/bin/env node\nconsole.log('1.0.0');\n", { mode: 0o755 });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({
      name: "omb-hostile-check", version: "1.0.0", bin: { "omb-hostile-check": "bin/omb-hostile-check" },
      scripts: { postinstall: "node -e \"require('fs').writeFileSync(process.env.OMB_TEST_POSTINSTALL, 'ran')\"" },
    }));
    const env = { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: home };
    const tarball = join(dir, execFileSync("npm", ["pack", "--silent", "--pack-destination", dir, pkg], { cwd: dir, env: { ...env, npm_config_cache: join(dir, "pack-cache") }, encoding: "utf8" }).trim().split("\n").at(-1)!);
    const install = async (boxed: boolean, prefix: string) => {
      mkdirSync(prefix, { recursive: true });
      const npmEnv = { ...npmEnvironment(env, env.PATH, boxed, data), OMB_TEST_POSTINSTALL: join(prefix, "postinstall-ran"), npm_config_offline: "true" };
      return runNpm(["install", "-g", "--prefix", prefix, "--loglevel=error", "--allow-scripts=omb-hostile-check", tarball], npmEnv, prefix, 120_000);
    };

    // The same install with the box off reads HOME's .npmrc: the stand-in for a bot's script runs the install script.
    const open = await install(false, join(dir, "open"));
    expect(open.code, open.output).toBe(0);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    rmSync(join(home, ".npm"), { recursive: true, force: true });

    const boxed = await install(true, join(dir, "boxed"));
    expect(boxed.code, boxed.output).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(dir, "boxed", "postinstall-ran"), "utf8")).toBe("ran");
    expect(existsSync(join(data, "tools", "npm-home", "cache"))).toBe(true);
    expect(existsSync(join(home, ".npm"))).toBe(false);
  }, 180_000);

  it.skipIf(!has("git"))("git ignores a .gitconfig in HOME: no insteadOf, no ext:: transport, no helper, no fsmonitor", () => {
    const hostile = hostileScript();
    const work = join(dir, "work");
    mkdirSync(work);
    const sh = (...args: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { env: { PATH: "/usr/bin:/bin", HOME: dir }, encoding: "utf8" });
    sh("init", "--quiet", "--initial-branch", "main");
    writeFileSync(join(work, "plan.md"), "v1");
    sh("add", "plan.md");
    sh("commit", "--quiet", "-m", "one");
    const origin = join(dir, "origin.git");
    execFileSync("git", ["clone", "--quiet", "--bare", work, origin], { env: { PATH: "/usr/bin:/bin", HOME: dir } });
    writeFileSync(join(home, ".gitconfig"), [
      `[url "ext::${hostile} -c true"]`, `\tinsteadOf = file://`,
      `[protocol "ext"]`, `\tallow = always`,
      `[core]`, `\tfsmonitor = ${hostile}`,
      `[credential]`, `\thelper = !${hostile}`,
    ].join("\n") + "\n");
    const clone = (boxed: boolean, into: string) => {
      const run = gitInvocation(["clone", "--quiet", "--", `file://${origin}`, into], { PATH: "/usr/bin:/bin", HOME: home }, boxed, home);
      try { execFileSync("git", [...run.args], { env: run.env, stdio: ["ignore", "ignore", "pipe"] }); return true; } catch { return false; }
    };

    clone(false, join(dir, "open"));
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(clone(true, join(dir, "boxed"))).toBe(true);
    const run = gitInvocation(["-C", join(dir, "boxed"), "status", "--porcelain"], { PATH: "/usr/bin:/bin", HOME: home }, true, home);
    execFileSync("git", run.args, { env: run.env });
    expect(readFileSync(join(dir, "boxed", "plan.md"), "utf8")).toBe("v1");
    expect(existsSync(marker)).toBe(false);
  });
});
