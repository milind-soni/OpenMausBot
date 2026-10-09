import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

// The published images: the self-hosted server (the default target) and the
// Cloud home (docs/cloud-pro.md). A pull downloads every layer whose digest
// changed, and a layer's digest changes when anything beneath it does.
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const workflow = parse(readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8"));

interface Step { op: string; args: string }
interface Stage { name: string; from: string; steps: Step[] }

function stages(text: string): Stage[] {
  const all: Stage[] = [];
  let pending = "";
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line) || (!pending && !line.trim())) continue;
    pending += line.endsWith("\\") ? `${line.slice(0, -1)} ` : line;
    if (line.endsWith("\\")) continue;
    const [, op, args] = /^\s*(\S+)\s*([\s\S]*)$/.exec(pending)!;
    pending = "";
    if (op.toUpperCase() === "FROM") {
      const [, from, name] = /^(\S+)(?:\s+AS\s+(\S+))?$/i.exec(args.trim())!;
      all.push({ name: name ?? `#${all.length}`, from, steps: [] });
    } else all.at(-1)?.steps.push({ op: op.toUpperCase(), args: args.trim() });
  }
  return all;
}

const all = stages(dockerfile);
/** Every instruction a target's image is built from, its parents' first. */
function chain(target: string): Step[] {
  const stage = all.find(s => s.name === target);
  if (!stage) throw new Error(`the Dockerfile has no ${target} stage`);
  return [...(all.some(s => s.name === stage.from) ? chain(stage.from) : []), ...stage.steps];
}
const shipped = () => all.filter(s => s.name !== "build" && s.name !== "edge").flatMap(s => s.steps);
const npmInstall = (step: Step) => step.op === "RUN" && /\bnpm install\b/.test(step.args);
const browserRun = () => chain("runtime").find(step => step.op === "RUN" && step.args.includes("agent-browser install"))!;
const grokRun = (steps: Step[]) => steps.findIndex(step => step.op === "RUN" && step.args.includes("https://x.ai/cli/install.sh"));
// The keys step parses Chrome for Testing's JSON with jq, as on GitHub's runners.
const jq = process.platform === "win32" ? "" : spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim();

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("container images", () => {
  it("keeps the self-hosted server the default target, and Cloud home a target of the same file", () => {
    expect(all.at(-1)!.name).toBe("server");
    expect(all.find(s => s.name === "cloud-home")!.from).toBe("runtime");
    expect(all.find(s => s.name === "server")!.from).toBe("runtime");
    // the build arg docker-compose.yml passes keeps its name and empty default
    expect(chain("server")).toContainEqual({ op: "ARG", args: 'ENGINES=""' });
  });

  it("puts the browser and the engines beneath the per-commit app files, so a code change leaves them as they were", () => {
    for (const target of ["server", "cloud-home"]) {
      const steps = chain(target);
      const heavy = steps.flatMap((step, i) => (npmInstall(step) ? [i] : []));
      const app = steps.flatMap((step, i) => (step.op === "COPY" && !step.args.includes("--from=edge") ? [i] : []));
      // agent-browser + Chrome, then the engines, then the app files (and the Cloud home's Caddyfile)
      expect(heavy, target).toHaveLength(2);
      expect(steps.filter(step => step.op === "COPY" && step.args.includes("--from=build")), target).toHaveLength(2);
      expect(Math.max(...heavy), target).toBeLessThan(Math.min(...app));
    }
  });

  it("leaves no npm or compile cache in a layer: each install removes its own in the same step", () => {
    const installs = shipped().filter(npmInstall);
    expect(installs.length).toBeGreaterThanOrEqual(3);
    for (const { args } of installs) {
      const cache = /--cache (\S+)/.exec(args)?.[1] ?? /\bHOME=(\S+) npm install\b/.exec(args)?.[1];
      expect(cache, args).toMatch(/^\/tmp\//);
      const removed = /\brm -rf ([^;&|]+)/.exec(args)?.[1].split(/\s+/) ?? [];
      expect(removed, args).toEqual(expect.arrayContaining([cache, "/tmp/node-compile-cache"]));
    }
  });

  it("ships Caddy once, without its file capability, and the app files once, root's without a rewrite", () => {
    for (const { args } of shipped()) expect(args).not.toMatch(/\bch(own|mod) -R\b/);
    // modes are fixed where the files are built, in a stage that is not shipped
    const build = all.find(s => s.name === "build")!.steps.find(step => step.op === "RUN" && step.args.startsWith("pnpm build:server"))!;
    expect(build.args).toMatch(/ && chmod -R go-w dist dist-server$/);
    // a plain copy to a fresh inode drops the privileged-port capability and the 1001 owner
    expect(all.find(s => s.name === "edge")!.steps).toContainEqual({ op: "RUN", args: "cp /usr/bin/caddy /caddy" });
    const home = chain("cloud-home");
    expect(home.filter(step => step.args.includes("/usr/local/bin/caddy") && step.op === "COPY")).toEqual([
      { op: "COPY", args: "--from=edge /caddy /usr/local/bin/caddy" },
    ]);
    // pinned, so beneath the engines: an engine release does not re-pull it
    expect(home.findIndex(step => step.args.startsWith("--from=edge "))).toBeLessThan(home.findLastIndex(npmInstall));
    expect(home.filter(step => step.op === "RUN" && /\b(cp|mv)\b[^&]*caddy/.test(step.args))).toEqual([]);
    expect(home.filter(step => step.args.includes("--from=build")).map(step => step.args)).toEqual([
      "/src/dist-server ./dist-server", "/src/dist ./dist",
    ].map(path => `--from=build ${path}`));
    expect(chain("server").filter(step => step.args.includes("--from=build")).every(step => step.args.startsWith("--from=build --chown=maus:maus "))).toBe(true);
  });

  it("installs the pinned Grok in Cloud home only, beneath the engines and the app, from a home the same step removes", () => {
    const home = chain("cloud-home");
    const grok = grokRun(home);
    expect(grok).toBeGreaterThan(-1);
    expect(home.slice(0, grok)).toContainEqual({ op: "ARG", args: "GROK_VERSION=1.0.41" });
    // pinned, so an engine release or a code change does not re-pull it
    expect(grok).toBeLessThan(home.findLastIndex(npmInstall));
    expect(grok).toBeGreaterThan(home.indexOf(browserRun()));
    expect(grok).toBeLessThan(home.findIndex(step => step.args.includes("--from=build")));
    const { args } = home[grok];
    // the installer and the version check write only to a throwaway home, gone by the end of the step
    expect(args.match(/\bHOME=\S+/g)).toEqual(["HOME=/tmp/grok-install", "HOME=/tmp/grok-install"]);
    expect(args).toMatch(/ && install -m 0755 "\$\(readlink -f \/tmp\/grok-install\/\.grok\/bin\/grok\)" \/usr\/local\/bin\/grok /);
    expect(args).toContain('grep -qF "grok $GROK_VERSION "');
    expect(args).toMatch(/ && rm -rf \/tmp\/grok-install; +fi$/);
    expect(grokRun(chain("server"))).toBe(-1);
  });

  it("scans the saved images for every throwaway build directory, and for one Grok", () => {
    const scan = (workflow.jobs["build-and-smoke"].steps as { name?: string; run?: string }[])
      .find(step => step.name?.startsWith("Prove each image ships its files once"))!.run!;
    const cache = new RegExp(/cache = re\.compile\(r"(.*)"\)/.exec(scan)![1]);
    const removed = shipped().flatMap(step => [...step.args.matchAll(/\brm -rf ([^;&|]+)/g)].flatMap(match => match[1].trim().split(/\s+/)));
    const throwaway = [...new Set(removed.filter(path => path.startsWith("/tmp/")))].sort();
    expect(throwaway).toEqual(["/tmp/grok-install", "/tmp/node-compile-cache", "/tmp/npm-cache", "/tmp/omb-build-home"]);
    for (const path of throwaway) expect(cache.test(`${path.slice(1)}/leftover`), path).toBe(true);
    expect(scan).toContain('grok = files["usr/local/bin/grok"]');
  });

  it("keeps each image's runtime contract", () => {
    const last = (steps: Step[], op: string) => steps.filter(step => step.op === op).at(-1)?.args;
    const server = chain("server");
    expect(last(server, "USER")).toBe("maus");
    expect(last(server, "VOLUME")).toBe('["/data"]');
    expect(last(server, "CMD")).toBe('["node", "dist-server/server-launcher.js"]');
    expect(last(server, "HEALTHCHECK")).toContain("http://127.0.0.1:8799/api/health");
    const home = chain("cloud-home");
    expect(last(home, "USER")).toBe("root");
    expect(last(home, "VOLUME")).toBe('["/data"]');
    expect(last(home, "EXPOSE")).toBe("8080");
    expect(last(home, "CMD")).toBe('["node", "/app/dist-server/cloud-home-start.js"]');
    expect(last(home, "HEALTHCHECK")).toContain("http://127.0.0.1:8080/api/health");
    expect(last(chain("runtime"), "ENV")).toMatch(/^AGENT_BROWSER_EXECUTABLE_PATH=\/opt\/openmausbot-browser\/chrome .*NODE_ENV=production$/);
  });

  it("never runs a build step with HOME on the volume, so nothing lands in what a fresh volume starts with", () => {
    for (const target of ["server", "cloud-home"]) {
      const steps = chain(target);
      const home = steps.findIndex(step => step.op === "ENV" && /(^|\s)HOME=\/data\b/.test(step.args));
      expect(home, target).toBeGreaterThan(-1);
      expect(steps.slice(home).filter(step => step.op === "RUN"), target).toEqual([]);
    }
  });

  it.skipIf(process.platform === "win32")("keeps only agent-browser's native binary, and refuses when the command is not one", () => {
    const { args } = browserRun();
    const start = args.indexOf("native=");
    const end = args.indexOf("&& agent-browser --version", start);
    expect(start).toBeGreaterThan(args.indexOf("agent-browser install"));
    expect(end).toBeGreaterThan(start);
    const prune = args.slice(start, end);
    const run = (target: string, elf = true) => {
      const root = mkdtempSync(join(tmpdir(), "omb-agent-browser-"));
      temporaryDirectories.push(root);
      const bin = join(root, "lib/node_modules/agent-browser/bin");
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(root, "bin"));
      const names = ["agent-browser-darwin-arm64", "agent-browser-linux-arm64", "agent-browser-linux-musl-x64", "agent-browser-linux-x64", "agent-browser-win32-x64.exe", "agent-browser.js"];
      for (const name of names) writeFileSync(join(bin, name), name === "agent-browser-linux-x64" && elf ? "\x7fELF\x02\x01" : "#!/usr/bin/env node\n", { mode: 0o755 });
      symlinkSync(join(bin, target), join(root, "bin/agent-browser"));
      const result = spawnSync("sh", ["-c", prune], { env: { PATH: `${join(root, "bin")}:/usr/bin:/bin` }, encoding: "utf8" });
      return { status: result.status, left: readdirSync(bin).sort(), names };
    };
    expect(run("agent-browser-linux-x64")).toMatchObject({ status: 0, left: ["agent-browser-linux-x64", "agent-browser.js"] });
    // npm linking the JS wrapper instead must stop the build, not delete every native binary
    const wrapper = run("agent-browser.js");
    expect(wrapper.status).not.toBe(0);
    expect(wrapper.left).toEqual(wrapper.names);
    const script = run("agent-browser-linux-x64", false);
    expect(script.status).not.toBe(0);
    expect(script.left).toEqual(script.names);
  });

  it("builds Cloud home from the same Dockerfile in CI, with its own layer cache", () => {
    const smoke = workflow.jobs["build-and-smoke"].steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    expect(smoke).toContain("docker build --target cloud-home --build-arg CLOUD_HOME_ENGINES= -t omb-cloud-home:ci .");
    const steps = workflow.jobs.publish.steps as { id?: string; uses?: string; with?: Record<string, string> }[];
    const server = steps.find(step => step.uses?.startsWith("docker/build-push-action@") && step.id !== "home")!;
    const home = steps.find(step => step.id === "home")!;
    expect(home.with).not.toHaveProperty("file");
    expect(home.with!.target).toBe("cloud-home");
    expect(home.with!["build-args"]).not.toContain("BASE_IMAGE");
    expect(home.with!["cache-from"].split("\n")).toEqual(expect.arrayContaining(["type=gha", "type=gha,scope=cloud-home"]));
    expect(home.with!["cache-to"]).toBe("type=gha,scope=cloud-home,mode=max");
    // Both builds key the browser layer on the same Chrome, so they share it.
    for (const build of [server, home]) expect(build.with!["build-args"]).toContain("CHROME_CACHE_TAG=${{ steps.keys.outputs.chrome }}");
    expect(home.with!["build-args"]).toContain("CLOUD_HOME_ENGINES=${{ steps.keys.outputs.engines }}");
    expect(home.with!["build-args"]).toContain("ENGINES_CACHE_TAG=${{ steps.keys.outputs.engines_tag }}");
  });

  it("keys the browser and engine layers on the versions they install, so a release rebuilds them", () => {
    const runtime = all.find(s => s.name === "runtime")!.steps;
    const declared = runtime.findIndex(step => step.op === "ARG" && step.args.startsWith("CHROME_CACHE_TAG="));
    // declared after the apt step, so a Chrome release rebuilds only the browser layer
    expect(declared).toBeGreaterThan(runtime.findIndex(step => step.op === "RUN" && step.args.startsWith("apt-get update")));
    expect(declared).toBeLessThan(runtime.indexOf(browserRun()));
    expect(browserRun().args).toContain("${CHROME_CACHE_TAG");
    const home = all.find(s => s.name === "cloud-home")!.steps;
    expect(home).toContainEqual({ op: "ARG", args: 'CLOUD_HOME_ENGINES="@anthropic-ai/claude-code @openai/codex"' });
    expect(home.find(npmInstall)!.args).toContain("${ENGINES_CACHE_TAG");
    const keys = (workflow.jobs.publish.steps as { id?: string; env?: Record<string, string> }[]).find(step => step.id === "keys")!;
    expect(keys.env!.CLOUD_HOME_ENGINES).toBe("@anthropic-ai/claude-code @openai/codex");
  });

  it.skipIf(!jq)("resolves the current Chrome and engine releases, and keys on the date when a lookup fails", () => {
    const keys = (workflow.jobs.publish.steps as { id?: string; run?: string; env?: Record<string, string> }[]).find(step => step.id === "keys")!;
    const resolve = (ok: boolean) => {
      const root = mkdtempSync(join(tmpdir(), "omb-docker-keys-"));
      temporaryDirectories.push(root);
      const fake = (name: string, body: string) => writeFileSync(join(root, name), `#!/bin/sh\n${ok ? body : "exit 1"}\n`, { mode: 0o755 });
      fake("curl", `echo '{"channels":{"Stable":{"version":"154.0.8037.92","downloads":{}}}}'`);
      fake("npm", `case "$2" in @anthropic-ai/claude-code@latest) echo 2.1.291;; @openai/codex@latest) echo 0.160.1;; *) exit 1;; esac`);
      const output = join(root, "output");
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-e", "-c", keys.run!], {
        env: { ...keys.env, PATH: `${root}:${dirname(jq)}:/usr/bin:/bin`, GITHUB_OUTPUT: output }, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    };
    expect(resolve(true)).toEqual({
      chrome: "154.0.8037.92",
      engines: "@anthropic-ai/claude-code@2.1.291 @openai/codex@0.160.1",
      engines_tag: "",
    });
    const today = `date-${new Date().toISOString().slice(0, 10)}`;
    expect(resolve(false)).toEqual({ chrome: today, engines: "@anthropic-ai/claude-code @openai/codex", engines_tag: today });
  });
});
