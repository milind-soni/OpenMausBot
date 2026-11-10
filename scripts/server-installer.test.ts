import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "deploy", "install.sh");
const script = readFileSync(SCRIPT, "utf8");
const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "t0ken-of-the-registry";
const CODE = "ABCD-1234-EFGH";
const BOX_PASSED = '{"box":"bwrap","total":31,"passed":31,"failed":[],"results":[{"id":"config-hidden","ok":true},{"id":"messages-db-hidden","ok":true}]}';
const BOX_FAILED = '{"box":"bwrap","total":31,"passed":30,"failed":["config-hidden"],"results":[{"id":"config-hidden","ok":false}]}';
const FILES = "https://raw.githubusercontent.com/milind-soni/OpenMausBot";
const SOURCE = `${FILES}/v0.1.151`;
const REAL_TOOLS = ["sed", "awk", "grep", "cat", "head", "tail", "tr", "sort", "cut", "mkdir", "mktemp", "chmod", "chown", "mv", "rm", "dirname", "sh"];

/** A server that passes every check: Ubuntu 24.04, x86-64, 4 cores, 8 GB, 80 GB free, Docker 27, free ports, a domain that points here. */
const HEALTHY = {
  FAKE_UID: "0", FAKE_ARCH: "x86_64", FAKE_CPUS: "4", FAKE_FREE_GB: "80", FAKE_DOCKER: "27.3.1", FAKE_SECURITY: '["name=apparmor","name=seccomp,profile=builtin"]',
  FAKE_COMPOSE: "0", FAKE_PUBLIC_IP: "203.0.113.7", FAKE_LOCAL_IP: "10.0.0.5", FAKE_DNS: "203.0.113.7", FAKE_NOW: "1794268800", FAKE_THEIRS: "1794268790",
  FAKE_STABLE: "404", FAKE_RELEASE: "v0.1.151", FAKE_RELEASE_STATUS: "200", FAKE_HEALTH: "healthy", FAKE_HTTPS: "openmausbot",
  FAKE_IMAGE_ENV: '["PATH=/usr/bin","HOME=/data","OMB_IMAGE=server"]', FAKE_BOX_CHECK: BOX_PASSED, FAKE_SOURCE: "published",
};

interface Server {
  env?: Record<string, string>;
  osRelease?: string | null;
  memoryKb?: number;
  userns?: { max?: string; clone?: string };
  /** /sys/module/apparmor/parameters/enabled; null: the kernel has no AppArmor. */
  apparmor?: string | null;
  /** Leave these stand-ins out, as on a server without the tool. */
  without?: string[];
}

/** Stand-ins for every tool install.sh asks about the machine, written once: what each answers comes from the run's FAKE_ settings. */
const STUBS: Record<string, string> = {
  apparmor_parser: 'echo "apparmor_parser $*" >> "$FAKE_LOG"',
  id: 'echo "$FAKE_UID"',
  uname: 'echo "$FAKE_ARCH"',
  nproc: 'echo "$FAKE_CPUS"',
  sleep: 'echo "sleep $*" >> "$FAKE_LOG"',
  df: 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/sda1 0 0 $((FAKE_FREE_GB * 1048576)) 10% /"',
  ss: `case "$*" in *":80") printf '%s' "\${FAKE_SS_80:-}" ;; *":443") printf '%s' "\${FAKE_SS_443:-}" ;; esac`,
  getent: 'for address in ${FAKE_DNS:-}; do echo "$address STREAM $2"; done',
  ip: 'echo "2: eth0    inet $FAKE_LOCAL_IP/24 brd 10.0.0.255 scope global eth0"',
  date: `case "$*" in
  "-u +%s") echo "$FAKE_NOW" ;;
  "-u -d "*) echo "$FAKE_THEIRS" ;;
  "-u +%Y") echo "\${FAKE_YEAR:-2026}" ;;
  *) echo "2026-11-10 12:00" ;;
esac`,
  curl: `echo "curl $*" >> "$FAKE_LOG"
blocked() { case " \${FAKE_BLOCKED:-} " in *" $1 "*) return 0 ;; esac; return 1; }
case "$*" in
  *"-K -"*) cat >> "$FAKE_LOG.stdin"
    if blocked ghcr.io; then exit 7; fi
    case "$*" in */manifests/stable) printf '%s' "$FAKE_STABLE" ;; *) printf '%s' "$FAKE_RELEASE_STATUS" ;; esac ;;
  *cdn-cgi/trace*) printf 'fl=1\\nip=%s\\nts=1\\n' "$FAKE_PUBLIC_IP" ;;
  "-sSI "*) printf 'HTTP/2 405\\r\\ndate: Tue, 10 Nov 2026 12:00:00 GMT\\r\\n' ;;
  *ghcr.io/token*) if blocked ghcr.io; then exit 7; fi; printf '{"token":"${TOKEN}"}' ;;
  *releases/latest*) printf '{\\n  "tag_name": "%s",\\n  "name": "x"\\n}\\n' "$FAKE_RELEASE" ;;
  *--resolve*) printf '%s' "\${FAKE_HTTPS:-}" ;;
  *"/install.sh -o "*) exit 22 ;;
  *"${FILES}/"*" -o "*) case "$*" in
      *"${FILES}/main/"*) [ "$FAKE_SOURCE" = published ] || [ "$FAKE_SOURCE" = main-only ] || exit 22 ;;
      *) [ "$FAKE_SOURCE" = published ] || exit 22 ;;
    esac
    for last; do :; done
    case "$*" in
      *deploy/box/prepare-host.sh*) printf '#!/bin/sh\\necho "prepare-host profiles=$MAUSBOT_PROFILES_DIR" >> "$FAKE_LOG"\\nexit "\${FAKE_PREPARE:-0}"\\n' > "$last" ;;
      *) printf 'the repository file\\n' > "$last" ;;
    esac ;;
  *"get.docker.com -o "*) exit 22 ;;
  *) for last; do :; done
    host=$(printf '%s' "$last" | sed -e 's#^[a-z]*://##' -e 's#/.*##')
    if blocked "$host"; then exit 7; fi ;;
esac`,
  docker: `echo "docker $*" >> "$FAKE_LOG"
case "$*" in
  "version --format"*) [ -n "$FAKE_DOCKER" ] || exit 1; echo "$FAKE_DOCKER" ;;
  "info --format {{json .SecurityOptions}}") echo "$FAKE_SECURITY" ;;
  "info --format {{.DockerRootDir}}") echo /nonexistent/docker ;;
  "compose version") exit "$FAKE_COMPOSE" ;;
  "ps -q --filter label=com.docker.compose.project=openmausbot --filter publish="*) printf '%s' "\${FAKE_OURS:-}" ;;
  "ps -aq --filter name=mausbot-connector") printf '%s' "\${FAKE_CONNECTOR:-}" ;;
  "run --rm --network none --entrypoint id "*" -u") /usr/bin/id -u ;;
  "run --rm --network none --entrypoint id "*" -g") /usr/bin/id -g ;;
  compose*" ps -q omb") echo c1 ;;
  "image inspect -f {{json .Config.Env}} "*) echo "$FAKE_IMAGE_ENV" ;;
  "image inspect -f {{index .Config.Labels "*) echo "\${FAKE_IMAGE_VERSION-v0.1.151}" ;;
  "compose exec -T omb node dist-server/bot-box/box-check.js --public=none") echo "$FAKE_BOX_CHECK"; case "$FAKE_BOX_CHECK" in *'"failed":[]'*) ;; *) exit 1 ;; esac ;;
  "inspect --format {{.State.Health.Status}} c1") echo "$FAKE_HEALTH" ;;
esac`,
};

let stubs = "";
beforeAll(() => {
  stubs = mkdtempSync(join(tmpdir(), "omb-server-install-stubs-"));
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(stubs, name), 0o755);
  }
});
afterAll(() => rmSync(stubs, { recursive: true, force: true }));

/** Runs install.sh on a made-up server: only the stand-ins and a few plain tools on its PATH, and its files under a folder of the test's. */
function run(args: string[], server: Server = {}, kept?: { dir: string }) {
  const dir = kept?.dir ?? mkdtempSync(join(tmpdir(), "omb-server-install-"));
  if (!kept) dirs.push(dir);
  const bin = join(dir, "bin");
  const sysroot = join(dir, "sysroot");
  const install = join(dir, "opt", "openmausbot");
  const log = join(dir, "calls.log");
  rmSync(bin, { recursive: true, force: true });
  rmSync(log, { force: true });
  rmSync(sysroot, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, "opt"), { recursive: true });
  for (const name of REAL_TOOLS) {
    const found = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map((folder) => join(folder, name)).find((path) => existsSync(path));
    if (found) symlinkSync(found, join(bin, name));
  }
  for (const name of Object.keys(STUBS)) if (!server.without?.includes(name)) symlinkSync(join(stubs, name), join(bin, name));
  mkdirSync(join(sysroot, "etc"), { recursive: true });
  mkdirSync(join(sysroot, "proc", "sys", "user"), { recursive: true });
  mkdirSync(join(sysroot, "proc", "sys", "kernel"), { recursive: true });
  mkdirSync(join(sysroot, "sys", "module", "apparmor", "parameters"), { recursive: true });
  if (server.apparmor !== null) writeFileSync(join(sysroot, "sys", "module", "apparmor", "parameters", "enabled"), `${server.apparmor ?? "Y"}\n`);
  if (server.osRelease !== null) {
    writeFileSync(join(sysroot, "etc", "os-release"), server.osRelease ?? 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n');
  }
  writeFileSync(join(sysroot, "proc", "meminfo"), `MemTotal:       ${server.memoryKb ?? 8_100_000} kB\nMemFree:         1000000 kB\n`);
  writeFileSync(join(sysroot, "proc", "sys", "user", "max_user_namespaces"), `${server.userns?.max ?? "63000"}\n`);
  if (server.userns?.clone !== undefined) writeFileSync(join(sysroot, "proc", "sys", "kernel", "unprivileged_userns_clone"), `${server.userns.clone}\n`);
  const result = spawnSync("/bin/sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: bin, FAKE_LOG: log, OMB_INSTALL_SYSROOT: sysroot, OMB_INSTALL_DIR: install, MAUSBOT_ADMIN_URL: "https://admin.example.test", ...HEALTHY, ...server.env },
    timeout: 60_000,
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  const fixes = result.stdout.split("\n").filter((line) => line.startsWith("  FIX   ")).map((line) => line.slice(8));
  return { ...result, calls, fixes, dir, install, docker: calls.filter((call) => call.startsWith("docker ")), all: result.stdout + result.stderr };
}

const READS = /^docker (version --format|info --format|compose version$|ps -q --filter)/;

describe.skipIf(!posix)("deploy/install.sh", () => {
  it("is plain POSIX sh, as `curl … | sh` runs it", () => {
    expect(spawnSync("sh", ["-n", SCRIPT]).status).toBe(0);
    const dash = spawnSync("dash", ["-n", SCRIPT]);
    if (!dash.error) expect(dash.status).toBe(0);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    for (const bashism of [/\[\[/, /\bfunction\s+\w+/, /\blocal\s/, /<<</, /\$\{[A-Za-z_]+\[/, /\bsource\s/, /&>/]) expect(script, String(bashism)).not.toMatch(bashism);
  });

  it("runs nothing when the download is cut off, wherever the cut falls", () => {
    expect(script.trimEnd().split("\n").at(-1)).toBe('main "$@"');
    const lines = script.split("\n");
    const dir = mkdtempSync(join(tmpdir(), "omb-server-install-cut-"));
    dirs.push(dir);
    const marker = join(dir, "ran");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const name of [...REAL_TOOLS.filter((tool) => tool !== "sh"), "docker", "curl", "id", "uname", "nproc", "df", "ss", "getent", "ip", "date", "sleep"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${marker}"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    for (let cut = 1; cut < lines.length - 1; cut += 7) {
      const partial = join(dir, "partial.sh");
      writeFileSync(partial, lines.slice(0, cut).join("\n"));
      spawnSync("/bin/sh", [partial, "--domain", "maus.example.com"], { env: { PATH: bin, OMB_INSTALL_DIR: join(dir, "opt") }, timeout: 20_000 });
      expect(existsSync(marker), `cut after line ${cut}`).toBe(false);
      expect(existsSync(join(dir, "opt")), `cut after line ${cut}`).toBe(false);
    }
  });

  it("--check passes a ready server, names every check, and changes nothing", () => {
    const result = run(["--check", "--domain", "Maus.Example.com"], { env: { FAKE_UID: "1000" } });
    expect(result.all).toContain("This server is ready for MausBot. Nothing was changed.");
    expect(result.status).toBe(0);
    expect(result.fixes).toEqual([]);
    for (const line of [
      "operating system: Ubuntu 24.04.1 LTS", "processor: x86-64", "processor cores: 4", "memory: 7.7 GB", "Docker: 27.3.1, with Compose", "free disk: 80 GB",
      "ports 80 and 443: free", "user namespaces: on", "bots' sandbox: AppArmor is on, so this server can be prepared for it", "DNS: maus.example.com points at this server (203.0.113.7)",
      "outbound: the image registries and Let's Encrypt are reachable", "clock: right", "version: v0.1.151, the newest release",
    ]) expect(result.stdout).toContain(`  ok    ${line}`);
    expect(result.docker.filter((call) => !READS.test(call))).toEqual([]);
    expect(existsSync(result.install)).toBe(false);
    expect(result.calls.some((call) => call.includes("get.docker.com"))).toBe(false);
  });

  it.each<[string, Server, RegExp]>([
    ["Debian", { osRelease: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nVERSION_ID="12"\nID=debian\n' }, /^This server runs Debian GNU\/Linux 12 \(bookworm\)\. MausBot's installer runs on Ubuntu 22\.04 or 24\.04/],
    ["an old Ubuntu", { osRelease: 'PRETTY_NAME="Ubuntu 20.04.6 LTS"\nVERSION_ID="20.04"\nID=ubuntu\n' }, /^This server runs Ubuntu 20\.04\.6 LTS\./],
    ["no os-release", { osRelease: null }, /operating system can't be identified/],
    ["an ARM processor", { env: { FAKE_ARCH: "aarch64" } }, /^This server's processor is aarch64\..*pick an x86-64 server\.$/],
    ["one core", { env: { FAKE_CPUS: "1" } }, /^This server has 1 processor core\. MausBot needs at least 2/],
    ["2 GB of memory", { memoryKb: 2_000_000 }, /^This server has 1\.9 GB of memory\. MausBot needs at least 4 GB/],
    ["a full disk", { env: { FAKE_FREE_GB: "5" } }, /^This server has only 5 GB free at .*MausBot needs at least 20 GB/],
    ["no curl", { without: ["curl"] }, /^curl isn't installed\. Run: sudo apt-get install -y curl/],
    ["no Docker", { without: ["docker"] }, /^Docker isn't installed\. Run this again with --install-docker/],
    ["Docker stopped", { env: { FAKE_DOCKER: "" } }, /^Docker is installed but not running\. Start it with: sudo systemctl enable --now docker/],
    ["an old Docker", { env: { FAKE_DOCKER: "20.10.24" } }, /^Docker 20\.10\.24 is too old; MausBot needs Docker 24 or newer/],
    ["rootless Docker", { env: { FAKE_SECURITY: '["name=seccomp","name=rootless"]' } }, /^Docker runs in rootless mode here/],
    ["Docker without Compose", { env: { FAKE_COMPOSE: "1" } }, /^Docker is here without its Compose plugin\. Run: sudo apt-get install -y docker-compose-plugin/],
    ["port 80 taken", { env: { FAKE_SS_80: 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))' } }, /^Port 80 is already in use by nginx\. Stop what uses it \(for example: sudo systemctl disable --now nginx\)/],
    ["port 80 taken by another container", { env: { FAKE_SS_80: 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=9,fd=4))' } }, /^Port 80 is already in use by another Docker container\. Find it with: sudo docker ps/],
    ["port 443 taken by an unnamed program", { env: { FAKE_SS_443: "LISTEN 0 511 0.0.0.0:443 0.0.0.0:*" } }, /^Port 443 is already in use\. Stop what uses it, then run this again\.$/],
    ["a domain with no record", { env: { FAKE_DNS: "" } }, /^maus\.example\.com does not resolve yet\. Add an A record for it pointing at 203\.0\.113\.7/],
    ["a domain that points elsewhere", { env: { FAKE_DNS: "198.51.100.9" } }, /^maus\.example\.com points at 198\.51\.100\.9, not at this server \(203\.0\.113\.7\)\. Change its A record to 203\.0\.113\.7/],
    ["Let's Encrypt blocked", { env: { FAKE_BLOCKED: "acme-v02.api.letsencrypt.org" } }, /^This server can't reach acme-v02\.api\.letsencrypt\.org over HTTPS \(port 443\)\. Allow outbound HTTPS/],
    ["user namespaces off", { userns: { max: "0" } }, /^This server switches off user namespaces, which the bots' sandbox needs\. Run: printf/],
    ["unprivileged user namespaces off", { userns: { clone: "0" } }, /^This server switches off user namespaces/],
    ["no AppArmor", { apparmor: null }, /^This server is missing AppArmor or its tools, which the bots' sandbox needs\. Run: sudo apt-get install -y apparmor {2}then restart the server and run this again; or add --no-sandbox/],
    ["AppArmor without its tools", { without: ["apparmor_parser"] }, /^This server is missing AppArmor or its tools/],
    ["this repository's files blocked", { env: { FAKE_BLOCKED: "raw.githubusercontent.com" } }, /^This server can't reach raw\.githubusercontent\.com over HTTPS/],
    ["a clock an hour off", { env: { FAKE_THEIRS: "1794265200" } }, /^This server's clock is 60 minutes off, so HTTPS certificates will be refused\. Run: sudo timedatectl set-ntp true/],
    ["a release without an image", { env: { FAKE_RELEASE_STATUS: "404" } }, /^MausBot v0\.1\.151 has no server image yet/],
    ["a registry that is throttling", { env: { FAKE_RELEASE_STATUS: "429" } }, /^The image registry ghcr\.io did not say whether it has MausBot v0\.1\.151 \(it answered 429\)\. Run this again in a few minutes\.$/],
    ["the latest tag asked for", { env: { OMB_INSTALL_IMAGE: "ghcr.io/milind-soni/openmausbot:latest" } }, /^OMB_INSTALL_IMAGE names the latest tag/],
  ])("--check on %s prints the one thing to fix", (_name, server, sentence) => {
    const result = run(["--check", "--domain", "maus.example.com"], server);
    expect(result.fixes).toHaveLength(1);
    expect(result.fixes[0]).toMatch(sentence);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fix the 1 line(s) marked FIX above. Nothing was changed.");
    expect(result.docker.filter((call) => !READS.test(call))).toEqual([]);
    expect(existsSync(result.install)).toBe(false);
  });

  it("names every blocked address in one line, and both ghcr.io failures when the registry is cut off", () => {
    const result = run(["--check", "--domain", "maus.example.com"], { env: { FAKE_BLOCKED: "ghcr.io registry-1.docker.io" } });
    expect(result.fixes).toEqual([
      "This server can't reach ghcr.io registry-1.docker.io over HTTPS (port 443). Allow outbound HTTPS to them in your firewall, then run this again.",
      "The image registry ghcr.io did not say which versions exist (it answered 000). Check this server's outbound HTTPS, then run this again.",
    ]);
  });

  it("accepts ports its own install holds, a domain that names a local address, and a skipped DNS check", () => {
    const listening = 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=9,fd=4))';
    const own = run(["--check", "--domain", "maus.example.com"], { env: { FAKE_SS_80: listening, FAKE_SS_443: listening, FAKE_OURS: "c1" } });
    expect(own.fixes).toEqual([]);
    expect(own.stdout).toContain("  ok    ports 80 and 443: held by this install");
    const local = run(["--check", "--domain", "maus.example.com"], { env: { FAKE_DNS: "10.0.0.5" } });
    expect(local.stdout).toContain("DNS: maus.example.com points at this server (10.0.0.5)");
    const skipped = run(["--check", "--domain", "maus.example.com"], { env: { FAKE_DNS: "198.51.100.9", OMB_INSTALL_SKIP_DNS: "1" } });
    expect(skipped.fixes).toEqual([]);
    expect(skipped.stdout).toContain("note  The DNS record of maus.example.com was not checked, as asked.");
  });

  it("refuses a domain, an email or a code that is not one, before anything else", () => {
    for (const [args, sentence] of [
      [["--domain", "https://maus.example.com"], "is not a domain name"],
      [["--domain", "localhost"], "is not a full domain name"],
      [["--domain", "maus.example.com", "--email", "a b@example.com"], "email address doesn't look right"],
      [["--domain", "maus.example.com", "code;rm"], "That code doesn't look right"],
      [["--domain", "maus.example.com", "--dir", "relative"], "--dir needs a full path"],
      [["--frobnicate"], "Unknown option --frobnicate"],
    ] as const) {
      const result = run([...args]);
      expect(result.stderr).toContain(sentence);
      expect(result.status).toBe(1);
      expect(result.calls).toEqual([]);
    }
  });

  it("installs only as root, and only once every check passes", () => {
    const user = run(["--domain", "maus.example.com"], { env: { FAKE_UID: "1000" } });
    expect(user.stderr).toContain("Please run this as root: put sudo before sh, like this: curl -fsSL https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/install.sh | sudo sh -s -- --domain maus.example.com");
    expect(user.calls).toEqual([]);
    const small = run(["--domain", "maus.example.com"], { env: { FAKE_CPUS: "1" } });
    expect(small.status).toBe(1);
    expect(small.stderr).toContain("This server is not ready: fix the 1 line(s) marked FIX above, then run this again. Nothing was changed.");
    expect(small.docker.filter((call) => !READS.test(call))).toEqual([]);
    expect(existsSync(small.install)).toBe(false);
  });

  it("never installs Docker unasked", () => {
    const result = run(["--domain", "maus.example.com"], { without: ["docker"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker isn't installed. Install it with: curl -fsSL https://get.docker.com | sudo sh  and then run this again, or run this again with --install-docker.");
    expect(result.calls.some((call) => call.includes("get.docker.com -o"))).toBe(false);
    expect(existsSync(result.install)).toBe(false);
    const asked = run(["--domain", "maus.example.com", "--install-docker"], { without: ["docker"] });
    expect(asked.calls.some((call) => call.includes("https://get.docker.com -o"))).toBe(true);
    expect(asked.stderr).toContain("Docker's install script could not be downloaded.");
  });

  it("installs under one folder, pinned to the newest release, and says how the first admin signs in", () => {
    const result = run(["--domain", "maus.example.com", "--email", "owner@example.com"]);
    expect(result.all).toContain("MausBot is running at https://maus.example.com");
    expect(result.status).toBe(0);
    expect(readFileSync(join(result.install, ".env"), "utf8")).toContain("DOMAIN=maus.example.com\nOMB_IMAGE=ghcr.io/milind-soni/openmausbot:v0.1.151\nOMB_SIGNIN_EMAILS=owner@example.com\n");
    expect(statSync(join(result.install, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(result.install, "data")).mode & 0o777).toBe(0o700);
    for (const file of ["compose.yaml", "Caddyfile", "caddy/data", "caddy/config"]) expect(existsSync(join(result.install, file)), file).toBe(true);
    const changes = result.docker.filter((call) => !READS.test(call) && !call.includes(" ps -q omb") && !call.startsWith("docker inspect"));
    expect(changes).toEqual([
      "docker compose pull -q",
      'docker image inspect -f {{index .Config.Labels "org.opencontainers.image.version"}} ghcr.io/milind-soni/openmausbot:v0.1.151',
      "docker image inspect -f {{json .Config.Env}} ghcr.io/milind-soni/openmausbot:v0.1.151",
      'docker image inspect -f {{index .Config.Labels "org.opencontainers.image.version"}} ghcr.io/milind-soni/openmausbot:v0.1.151',
      "docker run --rm --network none --entrypoint id ghcr.io/milind-soni/openmausbot:v0.1.151 -u",
      "docker run --rm --network none --entrypoint id ghcr.io/milind-soni/openmausbot:v0.1.151 -g",
      "docker compose up -d --remove-orphans",
      "docker compose exec -T omb node dist-server/bot-box/box-check.js --public=none",
    ]);
    expect(result.stdout).toContain(`  cd ${result.install} && sudo docker compose exec omb openmausbot pair --label "First admin"`);
    expect(result.stdout).toContain("Or open https://maus.example.com/pair and sign in with an emailed code as: owner@example.com");
    expect(result.stdout).toContain(`Your data: ${result.install}/data`);
  });

  it("uses the stable channel once it is published, and never the latest tag", () => {
    const result = run(["--domain", "maus.example.com"], { env: { FAKE_STABLE: "200" } });
    expect(result.stdout).toContain("  ok    version: the stable channel");
    expect(readFileSync(join(result.install, ".env"), "utf8")).toContain("OMB_IMAGE=ghcr.io/milind-soni/openmausbot:stable\n");
    expect(script).not.toMatch(/openmausbot:latest/);
    expect(result.calls.some((call) => call.includes("releases/latest"))).toBe(false);
  });

  it("keeps the registry's token and the one-time code out of its output, and the token off every command line", () => {
    const connector = mkdtempSync(join(tmpdir(), "omb-server-install-connector-"));
    dirs.push(connector);
    writeFileSync(join(connector, "install.sh"), `# stands in for mausbot-connector's installer\necho "$MAUSBOT_ADMIN_URL $#" > "${connector}/ran"\nprintf '%s' "$1" > "${connector}/code"\n`);
    const result = run(["--domain", "maus.example.com", CODE], { env: { MAUSBOT_CONNECTOR_INSTALLER: join(connector, "install.sh") } });
    expect(result.status).toBe(0);
    expect(result.all).not.toContain(TOKEN);
    expect(result.all).not.toContain(CODE);
    expect(result.calls.join("\n")).not.toContain(TOKEN);
    expect(result.calls.join("\n")).not.toContain(CODE);
    expect(readFileSync(join(result.dir, "calls.log.stdin"), "utf8")).toContain(`header = "Authorization: Bearer ${TOKEN}"`);
    expect(readFileSync(join(connector, "ran"), "utf8")).toBe("https://admin.example.test 1\n");
    expect(readFileSync(join(connector, "code"), "utf8")).toBe(CODE);
  });

  it("with a code, checks that MausBot is reachable and hands the code to the connector's own installer, unchanged", () => {
    const blocked = run(["--check", "--domain", "maus.example.com", CODE], { env: { FAKE_BLOCKED: "admin.example.test" } });
    expect(blocked.fixes).toEqual(["This server can't reach admin.example.test over HTTPS (port 443). Allow outbound HTTPS to them in your firewall, then run this again."]);
    const connectorScript = readFileSync(join(ROOT, "connector", "install.sh"), "utf8");
    expect(connectorScript).toContain("CONNECTOR=mausbot-connector");
    expect(connectorScript).toContain("--install-docker) MAUSBOT_INSTALL_DOCKER=1 ;;");
    expect(connectorScript).toContain('ADMIN_URL="${MAUSBOT_ADMIN_URL:-@MAUSBOT_ADMIN_URL@}"');
    expect(script).toContain('curl -fsSL --max-time 60 "$ADMIN_URL/install.sh"');
    const missing = run(["--domain", "maus.example.com", CODE]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("MausBot is installed and running here, but the connector's installer could not be downloaded from https://admin.example.test. Nothing needs reinstalling");
    expect(existsSync(join(missing.install, "data"))).toBe(true);
  });

  it("run again, it repairs its own files and keeps the person's settings and data", () => {
    const first = run(["--domain", "maus.example.com"]);
    expect(first.status).toBe(0);
    const env = join(first.install, ".env");
    writeFileSync(env, `${readFileSync(env, "utf8")}OMB_SIGNIN_SMTP_URL=smtps://mail.example.com\n`);
    writeFileSync(join(first.install, "data", "messages.db"), "chats");
    writeFileSync(join(first.install, "compose.yaml"), "broken");
    const before = statSync(join(first.install, "data"));
    const listening = 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=9,fd=4))';
    const second = run([], { env: { FAKE_SS_80: listening, FAKE_SS_443: listening, FAKE_OURS: "c1", FAKE_RELEASE: "v0.1.152" } }, { dir: first.dir });
    expect(second.all).toContain("MausBot is running at https://maus.example.com");
    expect(second.status).toBe(0);
    expect(readFileSync(env, "utf8").split("\n").filter((line) => /^[A-Z_]+=/.test(line))).toEqual([
      "OMB_SIGNIN_SMTP_URL=smtps://mail.example.com", "DOMAIN=maus.example.com", "OMB_IMAGE=ghcr.io/milind-soni/openmausbot:v0.1.152", "COMPOSE_FILE=compose.yaml:compose.box.yaml",
    ]);
    expect(readFileSync(join(first.install, "compose.yaml"), "utf8")).toContain("name: openmausbot");
    expect(readFileSync(join(first.install, "data", "messages.db"), "utf8")).toBe("chats");
    const after = statSync(join(first.install, "data"));
    expect([after.mode, after.uid, after.gid]).toEqual([before.mode, before.uid, before.gid]);
    expect(second.docker.some((call) => call.includes("--entrypoint id"))).toBe(false);
  });

  it("says so when the server does not come up, or HTTPS does not answer", () => {
    const sick = run(["--domain", "maus.example.com"], { env: { FAKE_HEALTH: "starting", OMB_INSTALL_HEALTH_WAIT_S: "10" } });
    expect(sick.status).toBe(1);
    expect(sick.stderr).toContain("MausBot started but did not report healthy within 10 seconds.");
    const noCertificate = run(["--domain", "maus.example.com"], { env: { FAKE_HTTPS: "", OMB_INSTALL_HTTPS_WAIT_S: "10" } });
    expect(noCertificate.status).toBe(1);
    expect(noCertificate.stderr).toContain("MausBot is running, but https://maus.example.com did not answer within 10 seconds, usually because the certificate could not be issued.");
    expect(noCertificate.all).not.toContain("MausBot is running at");
  });

  it("--uninstall stops the server and keeps the data, saying where it is", () => {
    const nothing = run(["--uninstall"]);
    expect(nothing.stderr).toContain("MausBot isn't installed in");
    const installed = run(["--domain", "maus.example.com"]);
    writeFileSync(join(installed.install, "data", "messages.db"), "chats");
    const result = run(["--uninstall"], { env: { FAKE_CONNECTOR: "c9" } }, { dir: installed.dir });
    expect(result.status).toBe(0);
    expect(result.docker).toEqual([
      "docker compose down --remove-orphans",
      "docker ps -aq --filter name=mausbot-connector",
    ]);
    expect(result.stdout).toContain(`Your data is kept in ${result.install}/data, your settings in ${result.install}/.env and the HTTPS certificates in ${result.install}/caddy.`);
    expect(result.stdout).toContain("This command never deletes your data.");
    expect(result.stdout).toContain("This server is still connected to MausBot.");
    expect(readFileSync(join(result.install, "data", "messages.db"), "utf8")).toBe("chats");
    for (const file of [".env", "compose.yaml", "Caddyfile"]) expect(existsSync(join(result.install, file)), file).toBe(true);
    expect(script).not.toMatch(/down[^\n]*(-v\b|--volumes)/);
    expect(script.split("\n").filter((line) => /\brm -r/.test(line) && !line.includes("To delete it yourself"))).toEqual([]);
  });

  it("prepares the server for the bots' sandbox with the repository's own files, starts with its settings, and checks that it holds", () => {
    const result = run(["--domain", "maus.example.com"]);
    expect(result.status).toBe(0);
    for (const path of ["deploy/box/prepare-host.sh", "deploy/box/compose.box.yaml", "connector/profiles/seccomp-omb-home.json", "connector/profiles/omb-home-narrow.apparmor"]) {
      expect(result.calls.some((call) => call.startsWith("curl ") && call.includes(`${SOURCE}/${path} -o `)), path).toBe(true);
    }
    expect(result.calls).toContain(`prepare-host profiles=${result.install}/box/profiles`);
    expect(readFileSync(join(result.install, ".env"), "utf8")).toContain("COMPOSE_FILE=compose.yaml:compose.box.yaml\n");
    expect(readFileSync(join(result.install, "compose.box.yaml"), "utf8")).toBe("the repository file\n");
    expect(result.calls.indexOf(`prepare-host profiles=${result.install}/box/profiles`)).toBeLessThan(result.calls.indexOf("docker compose up -d --remove-orphans"));
    expect(result.stdout).toContain("The bots' sandbox is on: a bot cannot read the server's settings, keys or other bots' files.");
    for (const word of ["security_opt", "seccomp=", "apparmor="]) expect(script, word).not.toContain(word);
  });

  it("says so, and does not finish, when the sandbox does not hold or the server cannot be prepared", () => {
    const failed = run(["--domain", "maus.example.com"], { env: { FAKE_BOX_CHECK: BOX_FAILED } });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("MausBot is running, but its sandbox self-check did not show that a bot cannot read the server's settings (config-hidden)");
    expect(failed.all).not.toContain("MausBot is running at");
    const silent = run(["--domain", "maus.example.com"], { env: { FAKE_BOX_CHECK: '{"box":"bwrap","failed":[],"results":[]}' } });
    expect(silent.status).toBe(1);
    expect(silent.stderr).toContain("MausBot is running, but its bots' sandbox gave no answer to its self-check");
    const off = run(["--domain", "maus.example.com"], { env: { FAKE_BOX_CHECK: '{"box":"off","reason":"userns-refused"}' } });
    expect(off.stderr).toContain("gave no answer to its self-check");
    const refused = run(["--domain", "maus.example.com"], { env: { FAKE_PREPARE: "1" } });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("This server could not be prepared for the bots' sandbox (the reason is above).");
    expect(refused.docker).not.toContain("docker compose up -d --remove-orphans");
    const unpublished = run(["--domain", "maus.example.com"], { env: { FAKE_SOURCE: "missing" } });
    expect(unpublished.status).toBe(1);
    expect(unpublished.stderr).toContain(`The files that prepare this server for the bots' sandbox could not be downloaded from ${FILES}.`);
    expect(unpublished.docker).not.toContain("docker compose up -d --remove-orphans");
  });

  const box = (results: { id: string; ok: boolean; detail: string; severity?: string }[]) => JSON.stringify({
    box: "bwrap", bridge: "socat", mutate: [], passed: results.filter((result) => result.ok).length, total: results.length,
    failed: results.filter((result) => !result.ok).map((result) => result.id), results, skipped: [], durationMs: 109,
  });
  const hidden = { id: "config-hidden", ok: true, detail: "ENOENT" };

  it.each(["keyring-denied", "hostname-private", "cpu-list-readable", "fly-api-hidden", "egress-public-allowed"])("goes on with a warning when only %s fails, showing what the check said", (id) => {
    const result = run(["--domain", "maus.example.com"], { env: { FAKE_BOX_CHECK: box([hidden, { id, ok: false, detail: "exit null" }]) } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`  note  The sandbox's self-check did not pass ${id} (exit null).`);
    expect(result.stdout).toContain("The bots' sandbox is on:");
    expect(result.all).toContain("MausBot is running at https://maus.example.com");
  });

  it.each([
    "messages-db-hidden", "data-dir-empty", "other-bot-folder-hidden", "other-task-folder-hidden", "secret-not-on-disk", "tmp-private", "engine-read-only",
    "secret-not-in-env", "other-env-unreadable", "other-pid-hidden", "server-pid-hidden", "host-loopback-unreachable", "no-direct-internet", "harness-other-refused",
    "egress-loopback-refused", "egress-metadata-refused", "egress-private-refused", "no-provider-key-in-env", "broker-key-not-on-disk", "broker-wrong-token-refused",
    "broker-other-grant-refused", "own-cwd-rw", "bot-folder-rw", "engine-runs", "harness-internal-allowed", "broker-call-works", "base-url-is-broker",
    "a-check-added-next-year",
  ])("stops when %s fails", (id) => {
    const result = run(["--domain", "maus.example.com"], { env: { FAKE_BOX_CHECK: box([{ id, ok: false, detail: "sees 4 entries" }, hidden, { id: "keyring-denied", ok: false, detail: "exit null" }]) } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`MausBot is running, but its bots' sandbox failed its self-check: ${id} (sees 4 entries). Bots are not safely separated from the server.`);
    expect(result.stdout).toContain("  note  The sandbox's self-check did not pass keyring-denied (exit null).");
    expect(result.all).not.toContain("MausBot is running at");
  });

  it("stops when config.json is readable, and takes a check's own severity over its list", () => {
    const readable = run(["--domain", "maus.example.com"], { env: { FAKE_BOX_CHECK: box([{ id: "config-hidden", ok: false, detail: "read 212 bytes" }]) } });
    expect(readable.status).toBe(1);
    expect(readable.stderr).toContain("did not show that a bot cannot read the server's settings (config-hidden)");
    const marked = run(["--domain", "maus.example.com"], { env: { FAKE_BOX_CHECK: box([hidden, { id: "keyring-denied", ok: false, detail: "EACCES", severity: "must" }, { id: "new-soft-check", ok: false, detail: "slow", severity: "warn" }]) } });
    expect(marked.status).toBe(1);
    expect(marked.stderr).toContain("failed its self-check: keyring-denied (EACCES). Bots are not safely separated");
    expect(marked.stdout).toContain("  note  The sandbox's self-check did not pass new-soft-check (slow).");
    expect(script.match(/keyring-denied/g)).toHaveLength(1);
  });

  it("takes the sandbox's files and update.sh from the installed version's tag, from main only when the tag has none, and says which", () => {
    const tagged = run(["--domain", "maus.example.com"]);
    expect(tagged.stdout).toContain("  note  The sandbox's files are MausBot v0.1.151's own.");
    expect(tagged.stdout).toContain("  note  update.sh is MausBot v0.1.151's own.");
    expect(tagged.calls.some((call) => call.includes(`${FILES}/main/`))).toBe(false);
    const fallback = run(["--domain", "maus.example.com"], { env: { FAKE_SOURCE: "main-only" } });
    expect(fallback.status).toBe(0);
    expect(fallback.stdout).toContain("  note  The sandbox's files are the newest in the repository (v0.1.151 has none).");
    expect(fallback.stdout).toContain("  note  update.sh is the newest in the repository (v0.1.151 has none).");
    const order = fallback.calls.filter((call) => call.includes("deploy/box/prepare-host.sh")).map((call) => (call.includes("/v0.1.151/") ? "tag" : "main"));
    expect(order).toEqual(["tag", "main"]);
    expect(fallback.calls.filter((call) => call.includes("/v0.1.151/") && call.includes("compose.box.yaml"))).toEqual([]);
    const stable = run(["--domain", "maus.example.com"], { env: { FAKE_STABLE: "200", FAKE_IMAGE_VERSION: "0.1.160" } });
    expect(stable.stdout).toContain("  note  The sandbox's files are MausBot v0.1.160's own.");
    const unlabelled = run(["--domain", "maus.example.com"], { env: { FAKE_IMAGE_VERSION: "" } });
    expect(unlabelled.stdout).toContain("  note  The sandbox's files are the newest in the repository.");
    const copy = run(["--domain", "maus.example.com"], { env: { OMB_INSTALL_SOURCE: "https://mirror.example.test/omb" } });
    expect(copy.status).toBe(1);
    expect(copy.calls.some((call) => call.includes("https://mirror.example.test/omb/deploy/box/prepare-host.sh -o "))).toBe(true);
    expect(copy.calls.some((call) => call.includes(FILES) && call.includes(" -o "))).toBe(false);
  });

  it("leaves the sandbox out for a version that has none and when asked, and takes its settings back out", () => {
    const first = run(["--domain", "maus.example.com"]);
    expect(readFileSync(join(first.install, ".env"), "utf8")).toContain("COMPOSE_FILE=");
    const asked = run(["--no-sandbox"], { apparmor: null }, { dir: first.dir });
    expect(asked.status).toBe(0);
    expect(asked.stdout).toContain("note  This server will not be prepared for the bots' sandbox, as asked.");
    expect(readFileSync(join(first.install, ".env"), "utf8")).not.toContain("COMPOSE_FILE=");
    expect(asked.calls.some((call) => call.startsWith("prepare-host"))).toBe(false);
    expect(asked.docker.some((call) => call.includes("box-check"))).toBe(false);
    const old = run(["--domain", "maus.example.com"], { env: { FAKE_IMAGE_ENV: '["PATH=/usr/bin","HOME=/data"]' } });
    expect(old.status).toBe(0);
    expect(old.stdout).toContain("note  This MausBot version has no bots' sandbox yet. Run this command again after updating to a version that has it.");
    expect(readFileSync(join(old.install, ".env"), "utf8")).not.toContain("COMPOSE_FILE=");
    expect(old.calls.some((call) => call.includes("deploy/box/"))).toBe(false);
  });

  it("places update.sh as the repository has it, names it as the way to update, and keeps the version it pinned", () => {
    const first = run(["--domain", "maus.example.com"], { env: { FAKE_STABLE: "200" } });
    expect(first.calls.some((call) => call.includes(`${SOURCE}/deploy/update.sh -o `))).toBe(true);
    expect(readFileSync(join(first.install, "update.sh"), "utf8")).toBe("the repository file\n");
    expect(statSync(join(first.install, "update.sh")).mode & 0o777).toBe(0o755);
    expect(first.stdout).toContain(`To update later, with a backup first and a way back:  sudo ${first.install}/update.sh`);
    const env = join(first.install, ".env");
    const pin = `ghcr.io/milind-soni/openmausbot@sha256:${"a".repeat(64)}`;
    writeFileSync(env, readFileSync(env, "utf8").replace("OMB_IMAGE=ghcr.io/milind-soni/openmausbot:stable", `OMB_IMAGE=${pin}`));
    const again = run([], { env: { FAKE_STABLE: "200" } }, { dir: first.dir });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("  ok    version: the one update.sh pinned here; it stays until update.sh changes it");
    expect(readFileSync(env, "utf8")).toContain(`OMB_IMAGE=${pin}\n`);
    expect(readFileSync(env, "utf8")).not.toContain(":stable");
    expect(again.calls.some((call) => call.includes("ghcr.io/token"))).toBe(false);
    const unpublished = run(["--domain", "maus.example.com", "--no-sandbox"], { env: { FAKE_SOURCE: "missing" } });
    expect(unpublished.status).toBe(0);
    expect(existsSync(join(unpublished.install, "update.sh"))).toBe(false);
    expect(unpublished.stdout).toContain("To update later, run this command again.");
  });

  it("writes the Caddyfile and the server's settings the manual Compose setup uses", () => {
    const caddyfile = readFileSync(join(ROOT, "deploy", "Caddyfile"), "utf8");
    const result = run(["--domain", "maus.example.com"]);
    expect(readFileSync(join(result.install, "Caddyfile"), "utf8")).toBe(caddyfile.slice(caddyfile.indexOf("{$DOMAIN} {")));
    const manual = readFileSync(join(ROOT, "deploy", "docker-compose.yml"), "utf8");
    const written = readFileSync(join(result.install, "compose.yaml"), "utf8");
    const settings = (text: string) => [...text.matchAll(/^ {6}(OMB_[A-Z_]+: .*)$/gm)].map((match) => match[1]);
    expect(settings(written)).toEqual(settings(manual));
    for (const line of ['test: ["CMD-SHELL", "curl -sf http://127.0.0.1:8799/api/health | grep -q openmausbot"]', 'network_mode: "service:omb"', "init: true", "shm_size: 512m", '- "80:80"', '- "443:443"']) {
      expect(written).toContain(line);
      expect(manual).toContain(line);
    }
    expect(written).toContain("- ./data:/data");
    expect(written).not.toContain("build:");
  });
});
