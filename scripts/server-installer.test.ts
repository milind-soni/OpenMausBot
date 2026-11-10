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
const REAL_TOOLS = ["sed", "awk", "grep", "cat", "head", "tail", "tr", "sort", "cut", "mkdir", "mktemp", "chmod", "chown", "mv", "rm", "dirname", "sh"];

/** A server that passes every check: Ubuntu 24.04, x86-64, 4 cores, 8 GB, 80 GB free, Docker 27, free ports, a domain that points here. */
const HEALTHY = {
  FAKE_UID: "0", FAKE_ARCH: "x86_64", FAKE_CPUS: "4", FAKE_FREE_GB: "80", FAKE_DOCKER: "27.3.1", FAKE_SECURITY: '["name=apparmor","name=seccomp,profile=builtin"]',
  FAKE_COMPOSE: "0", FAKE_PUBLIC_IP: "203.0.113.7", FAKE_LOCAL_IP: "10.0.0.5", FAKE_DNS: "203.0.113.7", FAKE_NOW: "1794268800", FAKE_THEIRS: "1794268790",
  FAKE_STABLE: "404", FAKE_RELEASE: "v0.1.151", FAKE_RELEASE_STATUS: "200", FAKE_HEALTH: "healthy", FAKE_HTTPS: "openmausbot",
};

interface Server {
  env?: Record<string, string>;
  osRelease?: string | null;
  memoryKb?: number;
  userns?: { max?: string; clone?: string };
  /** Leave these stand-ins out, as on a server without the tool. */
  without?: string[];
}

/** Stand-ins for every tool install.sh asks about the machine, written once: what each answers comes from the run's FAKE_ settings. */
const STUBS: Record<string, string> = {
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
      "ports 80 and 443: free", "DNS: maus.example.com points at this server (203.0.113.7)", "outbound: the image registries and Let's Encrypt are reachable",
      "user namespaces: on", "clock: right", "version: v0.1.151, the newest release",
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
    const compose = `docker compose --project-directory ${result.install} -f ${result.install}/compose.yaml`;
    const changes = result.docker.filter((call) => !READS.test(call) && !call.includes(" ps -q omb") && !call.startsWith("docker inspect"));
    expect(changes).toEqual([
      `${compose} pull -q`,
      "docker run --rm --network none --entrypoint id ghcr.io/milind-soni/openmausbot:v0.1.151 -u",
      "docker run --rm --network none --entrypoint id ghcr.io/milind-soni/openmausbot:v0.1.151 -g",
      `${compose} up -d --remove-orphans`,
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
      "OMB_SIGNIN_SMTP_URL=smtps://mail.example.com", "DOMAIN=maus.example.com", "OMB_IMAGE=ghcr.io/milind-soni/openmausbot:v0.1.152",
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
      `docker compose --project-directory ${result.install} -f ${result.install}/compose.yaml down --remove-orphans`,
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
