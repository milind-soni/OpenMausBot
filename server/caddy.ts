// `openmausbot serve --domain maus.example.com`: HTTPS on your own domain
// with nothing to configure. The server downloads a pinned Caddy once into
// the data dir (the same way it fetches cloudflared and the browser engine),
// writes the Caddyfile the Docker stack ships, and runs Caddy as its child:
// Caddy gets and renews the certificate from Let's Encrypt and forwards to
// the loopback server with the real Host and the forwarded headers the
// server's remote-session rules expect. The loopback bind never changes.
//
// What the operator still owns: a DNS record for the domain pointing at this
// machine, and ports 80 and 443 reachable. Binding those ports needs a
// privilege on Linux; `serve` says exactly which command grants it to the
// downloaded binary when Caddy reports the refusal.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export const CADDY_VERSION = "2.11.4";

/** Release assets by platform-arch, with the sha512 from the release's checksums file. */
export const CADDY_ASSETS: Readonly<Record<string, { name: string; sha512: string }>> = Object.freeze({
  "linux-x64": { name: `caddy_${CADDY_VERSION}_linux_amd64.tar.gz`, sha512: "8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9" },
  "linux-arm64": { name: `caddy_${CADDY_VERSION}_linux_arm64.tar.gz`, sha512: "d5a7c423853c24a799765e0e8210d5c7c22a8f56ed37a3cae2fb9f58be138853c02b4efd6b59d576e6d8c7c0d30b9c1592deeaa6a536ff69bcca23b8c1ea709c" },
  "darwin-x64": { name: `caddy_${CADDY_VERSION}_mac_amd64.tar.gz`, sha512: "e04eb10f9ce7e2e079bc9bff1bd5d3a3164888d1edbb1a49e5d15be4eab691b57e89ed36bb29c65ba43f1ba8d9279e0967b1003991c13fe4cb78384c3caf25de" },
  "darwin-arm64": { name: `caddy_${CADDY_VERSION}_mac_arm64.tar.gz`, sha512: "3190ae0df98b59ab4b6021556fa35adc3c526a4f3e138776b0eaec8a037cc26121cbbb1ad53453f565551b47d37d5ba4755e2c2c3652256737fe2ce9e53c8ec0" },
});

const DOWNLOAD_TIMEOUT_MS = 180_000;

export function caddyTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function pinnedCaddyPath(dataDir: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return join(dataDir, "caddy", `${CADDY_VERSION}-${caddyTarget(platform, arch)}`, platform === "win32" ? "caddy.exe" : "caddy");
}

/** OMB_CADDY_PATH, then the pinned download, then a `caddy` on PATH. */
export function resolveCaddyBinary(options: { dataDir: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string; exists?: (p: string) => boolean } ): string | null {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const override = env.OMB_CADDY_PATH?.trim();
  if (override) return resolve(override) === override && exists(override) ? override : null;
  const pinned = pinnedCaddyPath(options.dataDir, platform, options.arch);
  if (exists(pinned)) return pinned;
  const executable = platform === "win32" ? "caddy.exe" : "caddy";
  for (const part of (env.PATH ?? "").split(delimiter)) {
    const dir = part.trim();
    if (!dir) continue;
    const candidate = join(dir, executable);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Download the pinned release once, verify its digest, extract the binary. */
export async function ensureCaddy(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  /** Tests pin their own asset and URL; production resolves the release table. */
  asset?: { name: string; sha512: string; url?: string };
  log?: (line: string) => void;
}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const found = resolveCaddyBinary({ dataDir: options.dataDir, env: options.env, platform, arch: options.arch });
  if (found) return found;
  if (platform === "win32") throw new Error("--domain is not available on Windows yet; put your own HTTPS proxy in front (docs/self-hosting.md)");
  const target = caddyTarget(platform, options.arch);
  const asset: { name: string; sha512: string; url?: string } | undefined = options.asset ?? CADDY_ASSETS[target];
  if (!asset) throw new Error(`Caddy publishes no build for ${target}`);
  const destination = pinnedCaddyPath(options.dataDir, platform, options.arch);
  const directory = join(destination, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const url = asset.url ?? `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${asset.name}`;
  options.log?.(`downloading Caddy ${CADDY_VERSION} once (about 15 MB, digest pinned) into ${directory}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  let body: Buffer;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`the Caddy download failed (HTTP ${response.status})`);
    body = Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
  const digest = createHash("sha512").update(body).digest("hex");
  if (digest !== asset.sha512) throw new Error("the Caddy download failed its SHA-512 check; nothing was installed");
  const scratch = mkdtempSync(join(tmpdir(), "openmaus-caddy-"));
  try {
    const archive = join(scratch, asset.name);
    writeFileSync(archive, body, { mode: 0o600 });
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", scratch, "caddy"], { stdio: "ignore" });
    if (extracted.status !== 0) throw new Error("the Caddy archive could not be extracted (is `tar` installed?)");
    const staging = `${destination}.${randomBytes(6).toString("hex")}.part`;
    renameSync(join(scratch, "caddy"), staging);
    chmodSync(staging, 0o755);
    renameSync(staging, destination);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return destination;
}

/** The Docker stack's Caddyfile with this server's ports; certificates and
 * state live under the data dir so they survive restarts and upgrades. */
export function caddyfileFor(input: { domain: string; appPort: number; webhookPort: number }): string {
  return [
    "# Written by openmausbot serve --domain. Edit the command, not this file.",
    "{",
    "\tadmin off",
    "\tlog {",
    "\t\tlevel WARN",
    "\t}",
    "}",
    "",
    `${input.domain} {`,
    "\tencode zstd gzip",
    "",
    "\t# Webhook ingress has its own per-hook secrets and is meant for third parties.",
    "\thandle /hooks/* {",
    `\t\treverse_proxy 127.0.0.1:${input.webhookPort}`,
    "\t}",
    "",
    "\thandle {",
    `\t\treverse_proxy 127.0.0.1:${input.appPort} {`,
    "\t\t\t# SSE: stream events as they arrive",
    "\t\t\tflush_interval -1",
    "\t\t}",
    "\t}",
    "}",
    "",
  ].join("\n");
}

export interface RunningCaddy {
  configFile: string;
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

/** Whether a Caddy exit was the ports refusing to bind (a privilege problem, not a config one). */
export function portPermissionRefused(output: string): boolean {
  return /permission denied|bind: operation not permitted|EACCES/i.test(output) && /:80|:443|listen/i.test(output);
}

export function portPermissionHint(binary: string): string {
  return process.platform === "linux"
    ? `Caddy may not bind ports 80 and 443 as this user. Grant it once with:\n  sudo setcap 'cap_net_bind_service=+ep' ${binary}\nthen run the same command again. (A service unit can grant the same capability.)`
    : "Caddy may not bind ports 80 and 443 as this user. Run the server as an administrator, or put your own HTTPS proxy in front.";
}

/** Run Caddy as a child with the Caddyfile for this domain. Resolves once
 * Caddy has stayed up for a moment; rejects with its output if it exits first. */
export async function startCaddy(options: {
  binary: string;
  dataDir: string;
  domain: string;
  appPort: number;
  webhookPort: number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  settleMs?: number;
}): Promise<RunningCaddy> {
  const home = join(options.dataDir, "caddy");
  mkdirSync(join(home, "data"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
  const configFile = join(home, "Caddyfile");
  writeFileSync(configFile, caddyfileFor(options), { mode: 0o600 });
  const child: ChildProcess = spawn(options.binary, ["run", "--config", configFile, "--adapter", "caddyfile"], {
    env: { ...(options.env ?? process.env), XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const receive = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (output.length < 16_384) output += text;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      // Caddy logs JSON; surface warnings and errors, keep the rest quiet.
      if (/"level":"(warn|error)"/.test(line) || /^\S+\s+(WARN|ERROR)/.test(line) || !line.startsWith("{")) options.log?.(`caddy: ${line.slice(0, 400)}`);
    }
  };
  child.stdout?.on("data", receive);
  child.stderr?.on("data", receive);
  const exited = new Promise<number | null>((done) => {
    child.once("error", () => done(1));
    child.once("exit", (code) => done(code));
  });
  const settled = await Promise.race([exited.then((code) => ({ code })), new Promise<{ code: undefined }>((r) => setTimeout(() => r({ code: undefined }), options.settleMs ?? 1500))]);
  if (settled.code !== undefined) {
    const reason = portPermissionRefused(output) ? portPermissionHint(options.binary) : output.trim().split("\n").slice(-3).join("\n");
    throw new Error(`Caddy stopped right after starting (exit ${settled.code}).\n${reason}`);
  }
  return {
    configFile,
    exited,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

/** `--domain` takes a bare hostname; the same shape Settings → Custom domain accepts. */
export function normalizeDomainOption(raw: string): string | { error: string } {
  const value = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!value || value.length > 253 || !value.includes(".") || /[\s/:@?#]/.test(value) || !value.split(".").every((part) => label.test(part))) {
    return { error: "--domain takes a bare hostname such as maus.example.com" };
  }
  if (/(?:^|\.)(?:localhost|local|internal|invalid)$/.test(value)) return { error: "--domain needs a public domain name that resolves to this machine" };
  return value;
}
