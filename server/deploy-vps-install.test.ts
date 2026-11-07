import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseArgs } from "./cli.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const INSTALL = resolve(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "vps", "install.sh");
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const HAS_SHELLCHECK = process.platform !== "win32" && spawnSync("shellcheck", ["--version"]).status === 0;

const LICENSE_SECRET = "LICENSE-SECRET-3f9a1c77";
const ANTHROPIC_SECRET = "ANTHROPIC-SECRET-8b2d40e1";

const PHASES = ["check_prereqs", "install_packages", "install_node", "install_caddy", "install_openmausbot", "install_engine", "check_dns", "fleet_init", "fleet_brand", "fleet_create", "summary"];

const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n';
const DEBIAN = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\n';
const FEDORA = "NAME=Fedora\nID=fedora\nVERSION_ID=41\n";
const STOCK_CADDYFILE = ":80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n";
const PACKAGED_CADDYFILE = [
  "# The Caddyfile is an easy way to configure your Caddy web server.",
  "#",
  "# Unless the file starts with a global options block, the first",
  "# uncommented line is always the address of your site.",
  "",
  ":80 {",
  "\t# Set this path to your site's directory.",
  "\troot * /usr/share/caddy",
  "",
  "\t# Enable the static file server.",
  "\tfile_server",
  "",
  "\t# Another common task is to set up a reverse proxy:",
  "\t# reverse_proxy localhost:8080",
  "}",
  "",
  "# Refer to the Caddy docs for more information:",
  "# https://caddyserver.com/docs/caddyfile",
  "",
].join("\n");

const STUB = `#!/bin/sh
p=$OMB_VPS_PREFIX
name=\${0##*/}
printf '%s' "$name" >> "$p/calls.log"
for a in "$@"; do printf ' %s' "$a" >> "$p/calls.log"; done
printf '\\n' >> "$p/calls.log"
case $name in
  id)
    if [ "\${1-}" = "-u" ] && [ -z "\${2-}" ]; then cat "$p/uid"; elif [ -f "$p/no-operator" ]; then exit 1; else echo 1000; fi ;;
  node) cat "$p/node-version" ;;
  apt-get)
    case "$*" in
      *"install -y nodejs"*) echo v24.1.0 > "$p/node-version" ;;
      *"install -y caddy"*) ln -s "$0" "$p/bin/caddy" ;;
    esac ;;
  curl | gpg)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then echo "# stub" > "$2"; fi
      shift
    done ;;
  systemctl)
    if [ "\${1-}" = "is-active" ]; then exit 3; fi ;;
  ss)
    if [ -f "$p/busy" ]; then echo "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*"; fi ;;
  getent)
    for a in $(cat "$p/dns"); do echo "$a STREAM host"; done ;;
  ip) echo "2: eth0    inet 203.0.113.5/24 brd 203.0.113.255 scope global eth0" ;;
  openmausbot)
    case "$1 $2" in
      "fleet list")
        if [ -f "$p/fleet-list" ]; then cat "$p/fleet-list"; else echo "no workspaces yet on example.test"; fi ;;
      "fleet init")
        domain=
        shift 2
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "--domain" ]; then domain=$2; fi
          shift
        done
        mkdir -p "$p/etc/openmausbot"
        if [ ! -f "$p/etc/openmausbot/fleet.json" ]; then printf '{\\n  "version": 1,\\n  "domain": "%s"\\n}\\n' "$domain" > "$p/etc/openmausbot/fleet.json"; fi
        grep -q 'omb\\.d' "$p/etc/caddy/Caddyfile" 2>/dev/null || printf '\\nimport /etc/caddy/omb.d/*.caddy\\n' >> "$p/etc/caddy/Caddyfile" ;;
      "fleet create")
        slug=$3
        host=$slug.example.test
        shift 3
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "--host" ]; then host=$2; fi
          shift
        done
        printf '%-24s https://%-40s :8810   running\\n' "$slug" "$host" >> "$p/fleet-list" ;;
    esac ;;
esac
exit 0
`;

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

describe.skipIf(process.platform === "win32")("deploy/vps/install.sh", () => {
  let root: string;
  let home: string;
  let work: string;
  let tmp: string;
  let prefix: string;
  let keys: { license: string; anthropic: string; logo: string; osRelease: string };
  let stubDir: string;
  let stubScript: string;

  beforeAll(() => {
    stubDir = realpathSync(mkdtempSync(join(tmpdir(), "omb-vps-stub-")));
    stubScript = join(stubDir, "stub");
    writeFileSync(stubScript, STUB, { mode: 0o755 });
  });

  afterAll(() => {
    removeTempDir(stubDir);
  });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "omb-vps-install-")));
    home = join(root, "home");
    work = join(root, "cwd");
    tmp = join(root, "tmp");
    prefix = join(root, "prefix");
    for (const dir of [home, work, tmp, prefix]) mkdirSync(dir);
    keys = { license: join(work, "license.key"), anthropic: join(work, "anthropic.key"), logo: join(work, "logo.png"), osRelease: join(root, "os-release") };
    writeFileSync(keys.license, `${LICENSE_SECRET}\n`, { mode: 0o600 });
    writeFileSync(keys.anthropic, `${ANTHROPIC_SECRET}\n`, { mode: 0o600 });
    writeFileSync(keys.logo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(keys.osRelease, UBUNTU);
  });

  afterEach(() => {
    removeTempDir(root);
  });

  const baseArgs = () => ["--domain", "example.test", "--admin", "owner@acme.test", "--reseller-name", "Acme Cloud"];

  function install(args: string[], env: Record<string, string> = {}, cwd = work): Ran {
    const result = spawnSync("sh", [INSTALL, ...args], {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmp, LANG: "C", ...env },
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` };
  }

  function dryRun(args: string[], env: Record<string, string> = {}): Ran {
    return install(["--dry-run", ...args], { OMB_VPS_PREFIX: prefix, OMB_VPS_OS_RELEASE: keys.osRelease, ...env });
  }

  function snapshot(dir: string): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        const info = statSync(path);
        return `${path} ${info.isDirectory() ? "dir" : info.size} ${info.mtimeMs}`;
      })
      .sort();
  }

  function phasesOf(text: string): string[] {
    return [...text.matchAll(/^== (\w+) ==$/gm)].map((match) => match[1]!);
  }

  function commandsOf(text: string): string[] {
    return text.split("\n").filter((line) => line.startsWith("+ "));
  }

  function tokenize(line: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let started = false;
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]!;
      if (quoted) {
        if (char === "'") quoted = false;
        else current += char;
      } else if (char === "'") {
        quoted = true;
        started = true;
      } else if (char === "\\") {
        i += 1;
        current += line[i] ?? "";
        started = true;
      } else if (char === " ") {
        if (started) tokens.push(current);
        current = "";
        started = false;
      } else {
        current += char;
        started = true;
      }
    }
    if (started) tokens.push(current);
    return tokens;
  }

  const fullArgs = () => [
    ...baseArgs(), "--admin", "second@acme.test", "--workspace", "acme", "--host", "app.customer.example", "--cap", "49.99", "--currency", "eur",
    "--operator", "maus", "--logo", "logo.png", "--accent", "#C2510A", "--tagline", "Teams that ship", "--support-url", "https://help.acme.test/support",
    "--license-key-file", "license.key", "--anthropic-key-file", "anthropic.key", "--version", "0.1.145", "--engine", "claude",
  ];

  describe("syntax", () => {
    it("is executable POSIX sh that parses", () => {
      expect(statSync(INSTALL).mode & 0o777).toBe(0o755);
      expect(readFileSync(INSTALL, "utf8").startsWith("#!/bin/sh\n")).toBe(true);
      execFileSync("sh", ["-n", INSTALL]);
    });

    it.skipIf(!HAS_SHELLCHECK)("passes shellcheck without findings", () => {
      const result = spawnSync("shellcheck", ["-s", "sh", INSTALL], { encoding: "utf8" });
      expect(result.stdout + result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it("never evals, builds commands from strings or pipes into a shell", () => {
      const source = readFileSync(INSTALL, "utf8");
      expect(source).not.toMatch(/\beval\b/);
      expect(source).not.toMatch(/\|\s*(sudo\s+)?(ba)?sh\b/);
      expect(source).not.toMatch(/\bsh\s+-c\b/);
    });
  });

  describe("dry run", () => {
    it("prints the phases in order with the exact fleet commands", () => {
      const ran = dryRun(fullArgs());
      expect(ran.status).toBe(0);
      expect(phasesOf(ran.stdout)).toEqual(PHASES);
      const lines = commandsOf(ran.stdout);
      expect(lines).toContain("+ openmausbot fleet init --domain example.test --reseller-name 'Acme Cloud' --currency EUR --operator maus");
      expect(lines).toContain(`+ openmausbot fleet brand --default --accent '#C2510A' --tagline 'Teams that ship' --support-url https://help.acme.test/support --logo ${join(work, "logo.png")}`);
      expect(lines).toContain(`+ openmausbot fleet create acme --admin owner@acme.test --admin second@acme.test --host app.customer.example --cap 49.99 --anthropic-key-file ${keys.anthropic} --license-key-file ${keys.license}`);
      expect(lines).toContain("+ npm install -g openmausbot@0.1.145");
      expect(lines).toContain("+ npm install -g @anthropic-ai/claude-code");
      expect(ran.stdout).toContain("dry run complete: nothing was changed");
    });

    it("runs the system install steps in the documented order on a blank server", () => {
      const ran = dryRun(baseArgs());
      expect(ran.status).toBe(0);
      const lines = commandsOf(ran.stdout);
      const at = (needle: string) => {
        const index = lines.findIndex((line) => line.includes(needle));
        expect(index, needle).toBeGreaterThanOrEqual(0);
        return index;
      };
      expect(at("apt-get install -y nftables curl ca-certificates gnupg")).toBeLessThan(at("npm install -g openmausbot@latest"));
      expect(at("npm install -g openmausbot@latest")).toBeLessThan(at("fleet init"));
      expect(at("fleet init")).toBeLessThan(at("fleet create"));
      const emailBlock = ran.stdout.indexOf("email owner@acme.test");
      expect(emailBlock).toBeGreaterThan(ran.stdout.indexOf("== install_caddy =="));
      expect(emailBlock).toBeLessThan(ran.stdout.indexOf("== fleet_init =="));
    });

    it("skips the brand step when no brand option is given and says so", () => {
      const ran = dryRun(baseArgs());
      expect(ran.stdout).toContain("== fleet_brand ==\nno brand options given");
      expect(commandsOf(ran.stdout).some((line) => line.includes("fleet brand"))).toBe(false);
    });

    it("never prints a secret", () => {
      const ran = dryRun(fullArgs(), { OMB_LICENSE_KEY: "ENV-SECRET-51c0" });
      expect(ran.status).toBe(0);
      for (const secret of [LICENSE_SECRET, ANTHROPIC_SECRET, "ENV-SECRET-51c0"]) expect(ran.output).not.toContain(secret);
      expect(ran.output).toContain(keys.license);
    });

    it("changes nothing under HOME, the working directory or the temp directory", () => {
      const before = { home: snapshot(home), work: snapshot(work), tmp: snapshot(tmp), prefix: snapshot(prefix) };
      const ran = dryRun(fullArgs());
      expect(ran.status).toBe(0);
      expect({ home: snapshot(home), work: snapshot(work), tmp: snapshot(tmp), prefix: snapshot(prefix) }).toEqual(before);
    });

    it("works as a plain user on this machine, without any test seam", () => {
      const ran = install(["--dry-run", ...baseArgs()]);
      expect(ran.status).toBe(0);
      expect(phasesOf(ran.stdout)).toEqual(PHASES);
      expect(ran.stdout).toContain("dry run complete");
      if (!IS_ROOT) expect(ran.stdout).toContain("warning: a real run would stop here: run this as root");
      if (process.platform === "darwin") expect(ran.stdout).toContain("this installer supports Ubuntu 24.04+ and Debian 12+");
    });

    it("explains an unsupported system as a warning, not a failure", () => {
      writeFileSync(keys.osRelease, FEDORA);
      const ran = dryRun(baseArgs());
      expect(ran.status).toBe(0);
      expect(ran.stdout).toContain("this installer supports Ubuntu 24.04+ and Debian 12+ (found fedora 41)");
    });

    it("lists the DNS record for a custom host and for the wildcard", () => {
      expect(dryRun([...baseArgs(), "--host", "app.customer.example"]).stdout).toMatch(/^ {2}A {4}app\.customer\.example {4}/m);
      expect(dryRun(baseArgs()).stdout).toMatch(/^ {2}A {4}\*\.example\.test {4}/m);
    });

    it("warns about a missing licence key and a missing mail relay, with the pair fallback", () => {
      const ran = dryRun(baseArgs());
      expect(ran.stdout).toContain("warning: no licence key");
      expect(ran.stdout).toContain("warning: no sign-in mail relay");
      expect(ran.stdout).toContain("openmausbot pair --port");
      const keyed = dryRun([...baseArgs(), "--license-key-file", keys.license]);
      expect(keyed.stdout).not.toContain("warning: no licence key");
      expect(dryRun(baseArgs(), { OMB_LICENSE_KEY: "from-env" }).stdout).not.toContain("warning: no licence key");
    });

    it("warns loudly, before the npm install, that a run without a pinned --version installs whatever latest is", () => {
      const ran = dryRun(baseArgs());
      expect(ran.status).toBe(0);
      const warning = ran.stdout.indexOf("warning: UNPINNED");
      expect(warning).toBeGreaterThan(ran.stdout.indexOf("== install_openmausbot =="));
      expect(warning).toBeLessThan(ran.stdout.indexOf("+ npm install -g openmausbot@latest"));
      const block = ran.stdout.slice(warning, ran.stdout.indexOf("+ npm install -g openmausbot@latest"));
      expect(block).toContain("no --version was given, so this installs openmausbot@latest");
      expect(block).toContain("as root");
      expect(block).toContain("install scripts");
      expect(block).toContain("npm view openmausbot version");
      expect(ran.stdout.slice(ran.stdout.indexOf("== summary =="))).toContain("warning: UNPINNED");
      const tag = dryRun([...baseArgs(), "--version", "next"]).stdout;
      expect(tag).toContain("warning: UNPINNED: --version next is a tag or a range");
      expect(tag).toContain("npm view openmausbot version");
      for (const version of ["0.1.145", "1.2.3-beta.1"]) {
        const pinned = dryRun([...baseArgs(), "--version", version]).stdout;
        expect(pinned, version).not.toContain("UNPINNED");
        expect(pinned).not.toContain("npm view openmausbot version");
      }
    });

    it("installs a local tarball by path, prints its sha256 and does not call it unpinned", () => {
      const tarball = join(work, "openmausbot-0.1.146.tgz");
      writeFileSync(tarball, "tarball bytes\n");
      const digest = createHash("sha256").update("tarball bytes\n").digest("hex");
      const ran = dryRun([...baseArgs(), "--package", "openmausbot-0.1.146.tgz"]);
      expect(ran.status, ran.output).toBe(0);
      expect(commandsOf(ran.stdout)).toContain(`+ npm install -g ${tarball}`);
      expect(commandsOf(ran.stdout).some((line) => line.includes("openmausbot@"))).toBe(false);
      expect(ran.stdout).toContain(`package: ${tarball}, sha256 ${digest}; a local tarball is pinned by its content`);
      expect(ran.stdout).toContain(`Package: ${tarball}, sha256 ${digest} (pinned by content)`);
      expect(ran.stdout).not.toContain("UNPINNED");
      expect(ran.stdout).not.toContain("npm view openmausbot version");
    });

    it("warns that a tarball address is not pinned and passes it to npm unchanged", () => {
      const url = "https://releases.acme.test/openmausbot-0.1.146.tgz";
      const ran = dryRun([...baseArgs(), "--package", url]);
      expect(ran.status, ran.output).toBe(0);
      expect(commandsOf(ran.stdout)).toContain(`+ npm install -g ${url}`);
      expect(ran.stdout).toContain(`warning: UNPINNED: --package ${url} is an address`);
      expect(ran.stdout).toContain("check its sha256");
      expect(ran.stdout).not.toContain("sha256 ");
    });

    it("prints usage for --help and exits 0", () => {
      const ran = install(["--help"]);
      expect(ran.status).toBe(0);
      expect(ran.stdout).toContain("Usage: install.sh --domain DOMAIN");
    });
  });

  describe("fleet commands parse with the real command line", () => {
    function fleetLines(text: string): string[][] {
      return commandsOf(text)
        .map((line) => tokenize(line.slice(2)))
        .filter((tokens) => tokens[0] === "openmausbot" && tokens[1] === "fleet")
        .map((tokens) => tokens.slice(1));
    }

    it("accepts every fleet line of a full run", () => {
      const lines = fleetLines(dryRun(fullArgs()).stdout);
      expect(lines.map((tokens) => tokens[1])).toEqual(["init", "brand", "create"]);
      for (const tokens of lines) {
        const parsed = parseArgs(tokens, {});
        expect(parsed, tokens.join(" ")).not.toHaveProperty("error");
      }
      expect(parseArgs(lines[0]!, {})).toMatchObject({ fleetAction: "init", domain: "example.test", resellerName: "Acme Cloud", currency: "EUR", operator: "maus" });
      expect(parseArgs(lines[1]!, {})).toMatchObject({
        fleetAction: "brand", brandDefault: true, brandPatch: { accent: "#C2510A", tagline: "Teams that ship", supportUrl: "https://help.acme.test/support" }, logoSource: join(work, "logo.png"),
      });
      expect(parseArgs(lines[2]!, {})).toMatchObject({
        fleetAction: "create", slug: "acme", admins: ["owner@acme.test", "second@acme.test"], host: "app.customer.example", cap: 49.99, anthropicKeyFile: keys.anthropic, licenseKeyFile: keys.license,
      });
    });

    it("accepts a logo URL and a minimal run", () => {
      const lines = fleetLines(dryRun([...baseArgs(), "--logo", "https://cdn.acme.test/logo.svg"]).stdout);
      expect(lines.map((tokens) => tokens[1])).toEqual(["init", "brand", "create"]);
      for (const tokens of lines) expect(parseArgs(tokens, {}), tokens.join(" ")).not.toHaveProperty("error");
      expect(parseArgs(lines[1]!, {})).toMatchObject({ logoSource: "https://cdn.acme.test/logo.svg" });
      const minimal = fleetLines(dryRun(baseArgs()).stdout);
      expect(minimal.map((tokens) => tokens[1])).toEqual(["init", "create"]);
      for (const tokens of minimal) expect(parseArgs(tokens, {}), tokens.join(" ")).not.toHaveProperty("error");
    });

    it("accepts every fleet line of a run that installs a tarball", () => {
      writeFileSync(join(work, "omb.tgz"), "x");
      const args = fullArgs();
      args.splice(args.indexOf("--version"), 2);
      const lines = fleetLines(dryRun([...args, "--package", "omb.tgz"]).stdout);
      expect(lines.map((tokens) => tokens[1])).toEqual(["init", "brand", "create"]);
      for (const tokens of lines) expect(parseArgs(tokens, {}), tokens.join(" ")).not.toHaveProperty("error");
      expect(parseArgs(lines[0]!, {})).toMatchObject({ fleetAction: "init", domain: "example.test", resellerName: "Acme Cloud" });
      expect(parseArgs(lines[2]!, {})).toMatchObject({ fleetAction: "create", slug: "acme", host: "app.customer.example" });
    });

    it("accepts the re-run form with --yes", () => {
      mkdirSync(join(prefix, "etc", "openmausbot"), { recursive: true });
      writeFileSync(join(prefix, "etc", "openmausbot", "fleet.json"), '{\n  "version": 1,\n  "domain": "example.test"\n}\n');
      const init = fleetLines(dryRun(baseArgs()).stdout)[0]!;
      expect(init).toContain("--yes");
      expect(parseArgs(init, {})).toMatchObject({ fleetAction: "init", yes: true });
    });

    it("quotes a name that holds a quote or a space so the line parses back to the same name", () => {
      const name = "O'Neil & Sons";
      const init = fleetLines(dryRun(["--domain", "example.test", "--admin", "a@acme.test", "--reseller-name", name]).stdout)[0]!;
      expect(parseArgs(init, {})).toMatchObject({ resellerName: name });
    });
  });

  describe("refusals", () => {
    const refuse = (args: string[], message: string | RegExp) => {
      const ran = dryRun(args);
      expect(ran.status, ran.output).toBe(2);
      expect(ran.stderr).toMatch(message);
      expect(ran.stdout).toBe("");
    };

    it("needs a domain, an admin and a reseller name", () => {
      refuse(["--admin", "a@acme.test", "--reseller-name", "Acme"], "--domain is required");
      refuse(["--domain", "example.test", "--reseller-name", "Acme"], "--admin is required");
      refuse(["--domain", "example.test", "--admin", "a@acme.test"], "--reseller-name is required");
    });

    it("rejects an invalid domain, admin, host or workspace", () => {
      for (const domain of ["localhost", "example", "https://example.test/x", "bad domain.test", "a..test", "-a.test", "host.local", "10.0.0.1"]) {
        refuse(["--domain", domain, "--admin", "a@acme.test", "--reseller-name", "Acme"], /--domain/);
      }
      refuse([...baseArgs(), "--admin", "not-an-email"], "--admin takes an email address");
      refuse([...baseArgs(), "--workspace", "Bad_Name"], "--workspace takes");
      refuse([...baseArgs(), "--host", "example.test"], "--host cannot be the fleet domain");
      refuse([...baseArgs(), "--host", "other.example.test"], "--host cannot sit under example.test");
      refuse([...baseArgs(), "--host", "192.0.2.1"], "--host takes a bare hostname");
    });

    it("rejects an unknown flag, a stray word and a flag without a value", () => {
      refuse([...baseArgs(), "--frobnicate"], 'unknown option --frobnicate');
      refuse([...baseArgs(), "stray"], "unknown option stray");
      refuse([...baseArgs(), "--tagline"], "--tagline needs a value");
      refuse([...baseArgs(), "--tagline", "--yes"], "--tagline needs a value, not --yes");
      refuse([...baseArgs(), "--tagline", "two\nlines"], "--tagline must be a single line");
    });

    it("rejects bad option values before touching anything", () => {
      refuse([...baseArgs(), "--accent", "red"], "--accent takes a colour");
      refuse([...baseArgs(), "--support-url", "http://help.acme.test"], "--support-url takes an https:// address");
      refuse([...baseArgs(), "--support-url", "https://user:pw@help.acme.test"], "--support-url takes an https:// address");
      refuse([...baseArgs(), "--engine", "codex"], "--engine takes claude");
      refuse([...baseArgs(), "--cap", "-5"], /--cap/);
      refuse([...baseArgs(), "--cap", "1.234"], "--cap takes a dollar amount");
      refuse([...baseArgs(), "--currency", "dollars"], "--currency takes a three-letter code");
      refuse([...baseArgs(), "--version", "1.0;rm -rf /"], "--version takes a version");
      refuse([...baseArgs(), "--operator", "Bad User"], "--operator takes a Unix user name");
      refuse(["--domain", "example.test", "--admin", "a@acme.test", "--reseller-name", "x".repeat(41)], "--reseller-name must be 40 characters or fewer");
    });

    it("rejects a package that is not a readable .tgz file or an https address, or that comes with --version", () => {
      const tarball = join(work, "omb.tgz");
      writeFileSync(tarball, "x");
      refuse([...baseArgs(), "--package", "missing.tgz"], `--package: ${join(work, "missing.tgz")} is not a readable, non-empty file`);
      refuse([...baseArgs(), "--package", "http://releases.acme.test/omb.tgz"], "--package takes a .tgz file or an https:// address");
      refuse([...baseArgs(), "--package", "ftp://releases.acme.test/omb.tgz"], "--package takes a .tgz file or an https:// address");
      refuse([...baseArgs(), "--package", "https://releases.acme.test/a b.tgz"], "--package address must not contain spaces");
      refuse([...baseArgs(), "--package", "omb.zip"], "must be a .tgz file made by npm pack");
      refuse([...baseArgs(), "--package", "--yes"], "--package needs a value, not --yes");
      refuse([...baseArgs(), "--package", tarball, "--version", "0.1.145"], "--package and --version cannot be used together");
      refuse([...baseArgs(), "--version", "0.1.145", "--package", tarball], "--package and --version cannot be used together");
      refuse([...baseArgs(), "--package", "https://releases.acme.test/omb.tgz", "--version", "latest"], "--package and --version cannot be used together");
      writeFileSync(join(work, "empty.tgz"), "");
      refuse([...baseArgs(), "--package", "empty.tgz"], "is not a readable, non-empty file");
      mkdirSync(join(work, "dir.tgz"));
      refuse([...baseArgs(), "--package", "dir.tgz"], "is not a readable, non-empty file");
    });

    it("rejects a logo that is not a file or an https address", () => {
      refuse([...baseArgs(), "--logo", "missing.png"], `--logo: ${join(work, "missing.png")} is not a readable file`);
      refuse([...baseArgs(), "--logo", "http://cdn.acme.test/logo.png"], "--logo takes an image file or an https:// address");
      refuse([...baseArgs(), "--logo", "ftp://cdn.acme.test/logo.png"], "--logo takes an image file or an https:// address");
    });

    it("rejects an unreadable or empty key file without reading it into the message", () => {
      refuse([...baseArgs(), "--license-key-file", "nope.key"], `--license-key-file: ${join(work, "nope.key")} is not a readable, non-empty file`);
      refuse([...baseArgs(), "--anthropic-key-file", "nope.key"], "--anthropic-key-file");
      const empty = join(work, "empty.key");
      writeFileSync(empty, "");
      refuse([...baseArgs(), "--license-key-file", empty], "not a readable, non-empty file");
      if (!IS_ROOT) {
        const locked = join(work, "locked.key");
        writeFileSync(locked, LICENSE_SECRET);
        chmodSync(locked, 0o000);
        refuse([...baseArgs(), "--license-key-file", locked], "not a readable, non-empty file");
        chmodSync(locked, 0o600);
      }
    });
  });

  describe("a real run against recording stubs", () => {
    function stubMachine(options: { uid?: number; node?: string; dns?: string; busyPorts?: boolean; operatorMissing?: boolean } = {}) {
      mkdirSync(join(prefix, "bin"), { recursive: true });
      writeFileSync(join(prefix, "uid"), String(options.uid ?? 0));
      writeFileSync(join(prefix, "node-version"), options.node ?? "v22.12.0");
      writeFileSync(join(prefix, "dns"), options.dns ?? "203.0.113.5");
      for (const flag of ["busy", "no-operator"]) rmSync(join(prefix, flag), { force: true });
      if (options.busyPorts) writeFileSync(join(prefix, "busy"), "");
      if (options.operatorMissing) writeFileSync(join(prefix, "no-operator"), "");
      for (const tool of ["id", "node", "apt-get", "curl", "gpg", "bash", "npm", "nft", "systemctl", "ss", "getent", "ip", "openmausbot"]) {
        rmSync(join(prefix, "bin", tool), { force: true });
        symlinkSync(stubScript, join(prefix, "bin", tool));
      }
      rmSync(join(prefix, "bin", "caddy"), { force: true });
    }

    function runStubbed(args: string[], env: Record<string, string> = {}): Ran {
      return install(args, { OMB_VPS_PREFIX: prefix, OMB_VPS_OS_RELEASE: keys.osRelease, ...env });
    }

    const calls = () => (existsSync(join(prefix, "calls.log")) ? readFileSync(join(prefix, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
    const mutating = () => calls().filter((line) => !/^(id|node|ss|getent|ip) /.test(line) && !line.startsWith("systemctl is-active"));

    function expectInOrder(log: string[], patterns: (string | RegExp)[]) {
      let from = 0;
      for (const pattern of patterns) {
        const index = log.findIndex((line, i) => i >= from && (typeof pattern === "string" ? line === pattern : pattern.test(line)));
        expect(index, `${String(pattern)} after index ${from} in\n${log.join("\n")}`).toBeGreaterThanOrEqual(from);
        from = index + 1;
      }
    }

    beforeEach(() => {
      stubMachine();
    });

    const fullRunArgs = () => [...baseArgs(), "--operator", "maus", "--logo", "logo.png", "--accent", "#C2510A", "--license-key-file", "license.key", "--anthropic-key-file", "anthropic.key", "--engine", "claude", "--cap", "50"];

    it("runs every phase in order and ends with a working summary", () => {
      const ran = runStubbed(fullRunArgs());
      expect(ran.status, ran.output).toBe(0);
      expect(phasesOf(ran.stdout)).toEqual(PHASES);
      expectInOrder(mutating(), [
        "apt-get update",
        "apt-get install -y nftables curl ca-certificates gnupg",
        /^curl .* https:\/\/deb\.nodesource\.com\/setup_24\.x$/,
        /^bash .*nodesource_setup\.sh$/,
        "apt-get install -y nodejs",
        /^curl .* https:\/\/dl\.cloudsmith\.io\/public\/caddy\/stable\/gpg\.key$/,
        /^gpg --batch --yes --dearmor -o .*caddy-stable-archive-keyring\.gpg /,
        /^curl .* https:\/\/dl\.cloudsmith\.io\/public\/caddy\/stable\/debian\.deb\.txt$/,
        "apt-get update",
        "apt-get install -y caddy",
        `caddy validate --config ${join(prefix, "etc/caddy/Caddyfile")} --adapter caddyfile`,
        "npm install -g openmausbot@latest",
        "npm install -g @anthropic-ai/claude-code",
        "openmausbot fleet init --domain example.test --reseller-name Acme Cloud --operator maus",
        `openmausbot fleet brand --default --accent #C2510A --logo ${keys.logo}`,
        `openmausbot fleet create main --admin owner@acme.test --cap 50 --anthropic-key-file ${keys.anthropic} --license-key-file ${keys.license}`,
      ]);
      expect(ran.stdout).toContain("https://main.example.test");
      expect(ran.stdout).toContain("A    *.example.test    203.0.113.5");
      expect(ran.stdout).toContain("openmausbot pair --port 8810 --public-url https://main.example.test");
      expect(ran.stdout).toContain("openmausbot fleet billing");
      expect(ran.stdout).toContain("warning: no sign-in mail relay");
      expect(ran.stdout).not.toContain("warning: no licence key");
    });

    it("gives npm the tarball path instead of a registry name and keeps the rest of the run unchanged", () => {
      const tarball = join(work, "omb.tgz");
      writeFileSync(tarball, "x");
      const ran = runStubbed([...fullRunArgs(), "--package", tarball]);
      expect(ran.status, ran.output).toBe(0);
      expect(phasesOf(ran.stdout)).toEqual(PHASES);
      expect(calls()).toContain(`npm install -g ${tarball}`);
      expect(calls().some((line) => line.startsWith("npm install -g openmausbot@"))).toBe(false);
      expect(ran.stdout).toContain(`sha256 ${createHash("sha256").update("x").digest("hex")}`);
      expect(ran.stdout).not.toContain("UNPINNED");
    });

    it("resolves the name before the first fleet command, which is what reloads Caddy", () => {
      const ran = runStubbed(baseArgs());
      expect(ran.status, ran.output).toBe(0);
      const log = calls();
      const dns = log.findIndex((line) => line.startsWith("getent ahostsv4 main.example.test"));
      const init = log.findIndex((line) => line.startsWith("openmausbot fleet init"));
      expect(dns).toBeGreaterThanOrEqual(0);
      expect(dns).toBeLessThan(init);
      expect(log.some((line) => line.startsWith("systemctl reload"))).toBe(false);
    });

    it("writes the global email block ahead of the import line the fleet adds", () => {
      const ran = runStubbed(baseArgs());
      expect(ran.status, ran.output).toBe(0);
      const caddyfile = readFileSync(join(prefix, "etc", "caddy", "Caddyfile"), "utf8");
      expect(caddyfile.startsWith("{\n\temail owner@acme.test\n}\n")).toBe(true);
      expect(caddyfile.indexOf("email owner@acme.test")).toBeLessThan(caddyfile.indexOf("import /etc/caddy/omb.d/*.caddy"));
      expect(statSync(join(prefix, "etc", "caddy", "Caddyfile")).mode & 0o777).toBe(0o644);
    });

    const caddyDir = () => join(prefix, "etc", "caddy");
    const backups = () => readdirSync(caddyDir()).filter((name) => /^Caddyfile\.pre-openmausbot\.\d{8}T\d{6}Z(?:\.\d+)?$/.test(name)).sort();

    it("keeps the stock Caddyfile as a backup and refuses to overwrite a hand-written one", () => {
      mkdirSync(join(prefix, "etc", "caddy"), { recursive: true });
      writeFileSync(join(prefix, "etc", "caddy", "Caddyfile"), STOCK_CADDYFILE);
      expect(runStubbed(baseArgs()).status).toBe(0);
      expect(backups()).toHaveLength(1);
      expect(readFileSync(join(caddyDir(), backups()[0]!), "utf8")).toBe(STOCK_CADDYFILE);

      const other = mkdtempSync(join(root, "other-"));
      prefix = other;
      stubMachine();
      mkdirSync(join(prefix, "etc", "caddy"), { recursive: true });
      writeFileSync(join(prefix, "etc", "caddy", "Caddyfile"), "mine.example.org {\n\trespond hi\n}\n");
      const ran = runStubbed(baseArgs());
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain("is not the stock file from the Caddy package");
      expect(calls().some((line) => line.startsWith("openmausbot"))).toBe(false);
      expect(readFileSync(join(prefix, "etc", "caddy", "Caddyfile"), "utf8")).toBe("mine.example.org {\n\trespond hi\n}\n");
    });

    it("recognises the packaged Caddyfile with its comments as stock", () => {
      mkdirSync(caddyDir(), { recursive: true });
      writeFileSync(join(caddyDir(), "Caddyfile"), PACKAGED_CADDYFILE);
      const ran = runStubbed(baseArgs());
      expect(ran.status, ran.output).toBe(0);
      expect(backups().map((name) => readFileSync(join(caddyDir(), name), "utf8"))).toEqual([PACKAGED_CADDYFILE]);
      expect(readFileSync(join(caddyDir(), "Caddyfile"), "utf8").startsWith("{\n\temail owner@acme.test\n}\n")).toBe(true);
    });

    it.each([
      ["serves its own site from /usr/share/caddy", "mine.example.org {\n\troot * /usr/share/caddy\n\tfile_server\n}\n"],
      ["mentions /usr/share/caddy only in a comment", "# copied from /usr/share/caddy\nmine.example.org {\n\trespond hi\n}\n"],
      ["mentions omb.d only in a comment", "# TODO: import /etc/caddy/omb.d/*.caddy\nmine.example.org {\n\trespond hi\n}\n"],
      ["has the import line commented out", "mine.example.org {\n\trespond hi\n}\n#import /etc/caddy/omb.d/*.caddy\n"],
      ["imports another omb.d folder", "mine.example.org {\n\trespond hi\n}\nimport /srv/omb.d/*.caddy\n"],
    ])("refuses a hand-written Caddyfile that %s, and leaves it untouched", (_label, content) => {
      mkdirSync(caddyDir(), { recursive: true });
      writeFileSync(join(caddyDir(), "Caddyfile"), content);
      const ran = runStubbed(baseArgs());
      expect(ran.status, ran.output).toBe(1);
      expect(ran.stderr).toContain("is not the stock file from the Caddy package");
      expect(ran.stderr).toContain("import /etc/caddy/omb.d/*.caddy");
      expect(readFileSync(join(caddyDir(), "Caddyfile"), "utf8")).toBe(content);
      expect(backups()).toEqual([]);
      expect(calls().some((line) => line.startsWith("openmausbot"))).toBe(false);
    });

    it("leaves alone a hand-written Caddyfile that already has the fleet's import line", () => {
      mkdirSync(caddyDir(), { recursive: true });
      const content = "{\n\temail ops@acme.test\n}\nmine.example.org {\n\trespond hi\n}\n  import /etc/caddy/omb.d/*.caddy  \n";
      writeFileSync(join(caddyDir(), "Caddyfile"), content);
      const ran = runStubbed(baseArgs());
      expect(ran.status, ran.output).toBe(0);
      expect(ran.stdout).toContain("already imports the workspaces folder; leaving it alone");
      expect(readFileSync(join(caddyDir(), "Caddyfile"), "utf8")).toBe(content);
    });

    it("backs the stock file up under a new name every time, even when an older backup exists", () => {
      mkdirSync(caddyDir(), { recursive: true });
      writeFileSync(join(caddyDir(), "Caddyfile.pre-openmausbot"), "an older backup\n");
      writeFileSync(join(caddyDir(), "Caddyfile"), STOCK_CADDYFILE);
      expect(runStubbed(baseArgs()).status).toBe(0);
      writeFileSync(join(caddyDir(), "Caddyfile"), PACKAGED_CADDYFILE);
      expect(runStubbed(baseArgs()).status).toBe(0);
      expect(readFileSync(join(caddyDir(), "Caddyfile.pre-openmausbot"), "utf8")).toBe("an older backup\n");
      expect(backups()).toHaveLength(2);
      expect(backups().map((name) => readFileSync(join(caddyDir(), name), "utf8")).sort()).toEqual([PACKAGED_CADDYFILE, STOCK_CADDYFILE].sort());
    });

    it("never gives a secret to any command or prints it", () => {
      const ran = runStubbed(fullRunArgs(), { OMB_LICENSE_KEY: "ENV-SECRET-51c0" });
      expect(ran.status, ran.output).toBe(0);
      const everything = `${ran.output}\n${calls().join("\n")}`;
      for (const secret of [LICENSE_SECRET, ANTHROPIC_SECRET, "ENV-SECRET-51c0"]) expect(everything).not.toContain(secret);
    });

    it("leaves no temporary directory behind", () => {
      expect(runStubbed(baseArgs()).status).toBe(0);
      expect(readdirSync(tmp)).toEqual([]);
    });

    it("starts a second run with init --yes and does not create the workspace again", () => {
      expect(runStubbed(baseArgs()).status).toBe(0);
      const firstCaddyfile = readFileSync(join(prefix, "etc", "caddy", "Caddyfile"), "utf8");
      const firstCalls = calls().length;

      const again = runStubbed(baseArgs());
      expect(again.status, again.output).toBe(0);
      const second = calls().slice(firstCalls);
      expect(second).toContain("openmausbot fleet init --domain example.test --reseller-name Acme Cloud --yes");
      expect(second.some((line) => line.startsWith("openmausbot fleet create"))).toBe(false);
      expect(second.some((line) => line.includes("nodesource") || line === "apt-get install -y caddy" || line === "apt-get install -y nodejs")).toBe(false);
      expect(again.stdout).toContain("workspace main already exists (running); not creating it again");
      expect(again.stdout).toContain("Existing workspaces keep their old release until you run: openmausbot fleet upgrade");
      expect(readFileSync(join(prefix, "etc", "caddy", "Caddyfile"), "utf8")).toBe(firstCaddyfile);
    });

    it("creates the workspace on a re-run when the fleet exists without it", () => {
      mkdirSync(join(prefix, "etc", "openmausbot"), { recursive: true });
      writeFileSync(join(prefix, "etc", "openmausbot", "fleet.json"), '{\n  "version": 1,\n  "domain": "example.test",\n  "reseller": { "smtp": { "urlFile": "/root/smtp.url", "from": "no-reply@acme.test" } }\n}\n');
      writeFileSync(join(prefix, "fleet-list"), `${"other".padEnd(24)} https://other.example.test :8810   running\n`);
      const ran = runStubbed(baseArgs());
      expect(ran.status, ran.output).toBe(0);
      expect(calls().some((line) => line.startsWith("openmausbot fleet create main "))).toBe(true);
      expect(calls()).toContain("openmausbot fleet init --domain example.test --reseller-name Acme Cloud --yes");
      expect(ran.stdout).not.toContain("warning: no sign-in mail relay");
    });

    it("stops on a workspace that is half provisioned", () => {
      mkdirSync(join(prefix, "etc", "openmausbot"), { recursive: true });
      writeFileSync(join(prefix, "etc", "openmausbot", "fleet.json"), '{\n  "version": 1,\n  "domain": "example.test"\n}\n');
      writeFileSync(join(prefix, "fleet-list"), `${"main".padEnd(24)} https://main.example.test :8810   error\n`);
      const ran = runStubbed(baseArgs());
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain("workspace main is error");
      expect(calls().some((line) => line.startsWith("openmausbot fleet create"))).toBe(false);
    });

    it("refuses a registry that belongs to another domain", () => {
      mkdirSync(join(prefix, "etc", "openmausbot"), { recursive: true });
      writeFileSync(join(prefix, "etc", "openmausbot", "fleet.json"), '{\n  "version": 1,\n  "domain": "other.test"\n}\n');
      const ran = runStubbed(baseArgs());
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain("belongs to a different domain");
    });

    it("refuses to run as a normal user", () => {
      stubMachine({ uid: 1000 });
      const ran = runStubbed(baseArgs());
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain("run this as root");
      expect(mutating()).toEqual([]);
    });

    it("refuses an unsupported system and an old release", () => {
      writeFileSync(keys.osRelease, FEDORA);
      const fedora = runStubbed(baseArgs());
      expect(fedora.status).toBe(1);
      expect(fedora.stderr).toContain("supports Ubuntu 24.04+ and Debian 12+");
      writeFileSync(keys.osRelease, 'ID=ubuntu\nVERSION_ID="22.04"\n');
      expect(runStubbed(baseArgs()).status).toBe(1);
      writeFileSync(keys.osRelease, 'ID=debian\nVERSION_ID="11"\n');
      expect(runStubbed(baseArgs()).status).toBe(1);
      expect(mutating()).toEqual([]);
      writeFileSync(keys.osRelease, DEBIAN);
      expect(runStubbed(baseArgs()).status).toBe(0);
    });

    it("refuses when ports 80 and 443 are taken by something else", () => {
      stubMachine({ busyPorts: true });
      const ran = runStubbed(baseArgs());
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain("ports 80 and 443 must be free");
      expect(mutating()).toEqual([]);
    });

    it("stops before the fleet when the name does not resolve or resolves elsewhere", () => {
      stubMachine({ dns: "" });
      const missing = runStubbed(baseArgs());
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("main.example.test does not resolve yet");
      expect(calls().some((line) => line.startsWith("openmausbot"))).toBe(false);

      stubMachine({ dns: "198.51.100.9" });
      const wrong = runStubbed(baseArgs());
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toContain("which is not an address of this server");
      expect(calls().some((line) => line.startsWith("openmausbot"))).toBe(false);
    });

    it("checks the custom host rather than the wildcard when --host is given", () => {
      const ran = runStubbed([...baseArgs(), "--host", "app.customer.example"]);
      expect(ran.status, ran.output).toBe(0);
      expect(calls().some((line) => line.startsWith("getent ahostsv4 app.customer.example"))).toBe(true);
      expect(calls()).toContain("openmausbot fleet create main --admin owner@acme.test --host app.customer.example");
      expect(ran.stdout).toContain("A    app.customer.example    203.0.113.5");
    });

    it("checks that a named operator exists", () => {
      stubMachine({ operatorMissing: true });
      const ran = runStubbed([...baseArgs(), "--operator", "ghost"]);
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain("--operator ghost is not a Unix user");
      expect(mutating()).toEqual([]);
    });
  });
});
