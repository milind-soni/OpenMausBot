// A Cloud home with an engine sign-in open never looks idle to the sleep handshake (server/cloud-power.ts): the real Claude
// paste-code and Codex device-code controllers, each running a stand-in CLI, behind the real ProviderAuthSessions, read by
// the real power report. Finishing, cancelling, failing and expiring each let the home sleep again, and the sign-in trace
// those flows write never holds the code, the link or the device code. No real CLI, network or credential.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUD_IDLE_AWAKE_MS, CLOUD_IDLE_WORK_MS, createCloudPower, type CloudPower } from "./cloud-power.ts";
import { ClaudeLoginController } from "./drivers/claude-login-auth.ts";
import { CODEX_DEVICE_SIGN_IN, CodexDeviceAuthController } from "./drivers/codex-device-auth.ts";
import { deviceAuthInstanceSurface } from "./drivers/device-auth.ts";
import { ProviderAuthSessions } from "./provider-auth-sessions.ts";
import { createSignInTrace, SIGN_IN_TRACE_FILE, type SignInTrace } from "./sign-in-trace.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const CLAUDE_CODE = "GOODCODE#abc", REFUSED_CODE = "WRONGCODE#abc", DEVICE_CODE = "0CSG-0IXIM";
// Claude's `auth login` / `auth status --json`: prints its link and reads the pasted code.
const FAKE_CLAUDE = `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME;
const args = process.argv.slice(2).join(' ');
if (args === 'auth status --json') {
  const signedIn = existsSync(join(home, 'claude-authenticated'));
  process.stdout.write(JSON.stringify({ loggedIn: signedIn }) + '\\n');
  process.exit(signedIn ? 0 : 1);
} else if (args === 'auth login') {
  process.stdout.write('If the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true&state=secret-state\\n');
  process.stdout.write('Paste code here if prompted > ');
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffered += chunk;
    if (!buffered.includes('\\n')) return;
    if (buffered.split('\\n')[0].trim() === ${JSON.stringify(CLAUDE_CODE)}) {
      writeFileSync(join(home, 'claude-authenticated'), 'fixture only');
      process.stdout.write('Login successful\\n');
      process.exit(0);
    }
    process.stderr.write('Invalid authorization code\\n');
    process.exit(1);
  });
} else process.exit(2);
`;
// Codex's `login --device-auth` / `login status`: shows the page and the code, then waits for the approval marker
// (FAKE_AUTH_MODE=crash: exits with a token-looking line instead).
const FAKE_CODEX = `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME;
const args = process.argv.slice(2).join(' ');
if (args === 'login status') {
  if (existsSync(join(home, 'codex-authenticated'))) { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }
  process.stderr.write('Not logged in\\n'); process.exit(1);
} else if (args === 'login --device-auth') {
  console.error('Open this link:');
  console.error('https://auth.openai.com/codex/device');
  console.error('Enter this one-time code (expires in 15 minutes)');
  console.error(${JSON.stringify(DEVICE_CODE)});
  if (process.env.FAKE_AUTH_MODE === 'crash') setTimeout(() => { console.error('access_token=secret-token'); process.exit(1); }, 50);
  else setInterval(() => {
    if (!existsSync(join(home, 'approve'))) return;
    writeFileSync(join(home, 'codex-authenticated'), 'fixture only');
    console.error('Successfully logged in'); process.exit(0);
  }, 50);
} else process.exit(4);
`;

describe("an engine sign-in on a Cloud home", () => {
  let home: string, clock: number, lines: string[];
  let trace: SignInTrace, sessions: ProviderAuthSessions, power: CloudPower;
  const disposers: Array<() => Promise<void>> = [];

  const claude = (options: { lifetimeMs?: number } = {}) => {
    const cli = join(home, "fake-claude.mjs");
    writeFileSync(cli, FAKE_CLAUDE, { mode: 0o700 });
    chmodSync(cli, 0o700);
    const login = new ClaudeLoginController({ cli, environment: () => ({ ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") }),
      startupTimeoutMs: 10_000, completeTimeoutMs: 10_000, terminateTimeoutMs: 50, lifetimeMs: options.lifetimeMs ?? 60_000 });
    disposers.push(() => login.dispose());
    // The instance id is the person's own account name: it must never reach the trace.
    return { instanceId: "claude-private-account", driverKind: "claudeAgent", startAuthentication: () => login.start(), getAuthentication: (flowId: string) => login.get(flowId),
      completeAuthentication: (flowId: string, code: string) => login.complete(flowId, code), cancelAuthentication: () => login.cancel(), signOut: () => login.signOut() };
  };
  const codex = (options: { mode?: string; lifetimeMs?: number } = {}) => {
    const cli = join(home, "fake-codex.mjs");
    writeFileSync(cli, FAKE_CODEX, { mode: 0o700 });
    chmodSync(cli, 0o700);
    const device = new CodexDeviceAuthController({ cli, environment: () => ({ ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), FAKE_AUTH_MODE: options.mode ?? "wait" }),
      startupTimeoutMs: 10_000, terminateTimeoutMs: 50, lifetimeMs: options.lifetimeMs ?? 60_000 });
    disposers.push(() => device.dispose());
    return { instanceId: "codex-private-account", driverKind: "codex", ...deviceAuthInstanceSurface(device, CODEX_DEVICE_SIGN_IN) };
  };
  /** The power report's busy codes, at the power clock's time. */
  const busy = () => power.report().busy;
  /** Past the home's own windows (just woke, work just ended), so only what is open now decides. */
  const settle = () => {
    // In the power clock's own 5 s ticks: a jump much larger than a tick reads as a resume from a suspend.
    for (const until = clock + Math.max(CLOUD_IDLE_AWAKE_MS, CLOUD_IDLE_WORK_MS) + 5_000; clock < until;) { clock += 5_000; power.tick(); }
  };
  const secrets = () => [CLAUDE_CODE, REFUSED_CODE, "BADCODE", DEVICE_CODE, "secret-state", "secret-token", "claude.com", "auth.openai.com", "private-account", "https://"];
  /** Everything the trace wrote: its file, its log lines and the health report's summary. */
  const written = () => [existsSync(join(home, SIGN_IN_TRACE_FILE)) ? readFileSync(join(home, SIGN_IN_TRACE_FILE), "utf8") : "", ...lines, JSON.stringify(trace.summary())].join("\n");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omb-sign-in-awake-"));
    clock = 1_800_000_000_000;
    lines = [];
    trace = createSignInTrace({ dataDir: home, log: (line) => lines.push(line) });
    sessions = new ProviderAuthSessions({ trace });
    power = createCloudPower({ dataDir: home, now: () => clock, broadcast: () => {}, probes: {
      turn: () => false, run: () => false, handoff: () => false, liveCall: () => false, computer: () => false,
      // The home's wiring (server/index.ts): a provider sign-in under way is maintenance.
      maintenance: () => sessions.active, nextDueAt: () => null,
    } });
    settle();
    expect(power.report()).toMatchObject({ idle: true, busy: [] });
  });
  afterEach(async () => {
    power.close();
    await Promise.all(disposers.splice(0).map((dispose) => dispose().catch(() => {})));
    await removeTempDir(home);
  });

  it("Claude: an open paste-code sign-in keeps it awake, a code that is not a code keeps it open, and the right code lets it sleep", async () => {
    const instance = claude();
    const started = await sessions.start(instance, "owner-session");
    expect(started).toMatchObject({ phase: "waiting" });
    settle();
    expect(busy()).toEqual(["maintenance"]);
    // While it is open, nothing the trace wrote holds the link, the flow or the account.
    for (const secret of [...secrets(), started.flowId!]) expect(written()).not.toContain(secret);
    expect(power.prepareSleep()).toEqual({ ok: false, busy: ["maintenance"] });

    // Too short to be a code: refused before it reaches Claude, and the sign-in is still open.
    await expect(sessions.complete(instance.instanceId, "owner-session", started.flowId!, "BADCODE")).rejects.toMatchObject({ reason: "wrong_code" });
    settle();
    expect(busy()).toEqual(["maintenance"]);

    await sessions.complete(instance.instanceId, "owner-session", started.flowId!, CLAUDE_CODE);
    expect(busy()).not.toContain("maintenance");
    settle();
    expect(power.report()).toMatchObject({ idle: true, busy: [] });
    expect(trace.summary()).toMatchObject({ attempts: 1, open: 0, engines: [{ kind: "claudeAgent", attempts: 1, completed: 1, last: { outcome: "completed" } }] });
    expect(trace.summary().recent.map((event) => event.outcome)).toEqual(["started", "wrong_code", "completed"]);
    expect(lines).toEqual(["sign-in: claudeAgent paste-code started", expect.stringMatching(/^sign-in: claudeAgent paste-code wrong_code after \d+s$/),
      expect.stringMatching(/^sign-in: claudeAgent paste-code completed after \d+s$/)]);
    for (const secret of secrets()) expect(written()).not.toContain(secret);
  }, 30_000);

  it("Claude: a code the provider refuses ends the sign-in and lets it sleep at once, not at the expiry", async () => {
    const instance = claude();
    const started = await sessions.start(instance, "owner-session");
    await expect(sessions.complete(instance.instanceId, "owner-session", started.flowId!, REFUSED_CODE)).rejects.toMatchObject({ reason: "refused" });
    settle();
    expect(power.report()).toMatchObject({ idle: true, busy: [] });
    expect(trace.summary().engines[0]).toMatchObject({ attempts: 1, completed: 0, last: { outcome: "refused" } });
    for (const secret of secrets()) expect(written()).not.toContain(secret);
  }, 30_000);

  it("Claude: cancelling lets it sleep", async () => {
    const instance = claude();
    const started = await sessions.start(instance, "owner-session");
    settle();
    expect(busy()).toEqual(["maintenance"]);
    await sessions.cancel(instance.instanceId, "owner-session", started.flowId!);
    settle();
    expect(power.report()).toMatchObject({ idle: true, busy: [] });
    expect(trace.summary().engines[0].last).toMatchObject({ outcome: "cancelled" });
  }, 30_000);

  it("Codex: an open device-code sign-in keeps it awake until the person approves it", async () => {
    const instance = codex();
    const started = await sessions.start(instance, "owner-session");
    expect(started).toMatchObject({ phase: "waiting", userCode: DEVICE_CODE });
    settle();
    expect(busy()).toEqual(["maintenance"]);
    for (const secret of [...secrets(), started.flowId!]) expect(written()).not.toContain(secret);
    expect(power.prepareSleep()).toMatchObject({ ok: false });

    writeFileSync(join(home, "approve"), "fixture only");
    // The sign-in screen polls the status, as SignInPill does.
    await expect.poll(async () => (await sessions.status(instance.instanceId, "owner-session", started.flowId!)).phase, { timeout: 10_000, interval: 100 }).toBe("succeeded");
    settle();
    expect(power.report()).toMatchObject({ idle: true, busy: [] });
    expect(trace.summary().engines).toEqual([expect.objectContaining({ kind: "codex", attempts: 1, completed: 1 })]);
    expect(lines[0]).toBe("sign-in: codex device-code started");
    for (const secret of secrets()) expect(written()).not.toContain(secret);
  }, 30_000);

  it("Codex: a login command that exits fails the sign-in and lets it sleep", async () => {
    const instance = codex({ mode: "crash" });
    const started = await sessions.start(instance, "owner-session");
    settle();
    expect(busy()).toEqual(["maintenance"]);
    await expect.poll(async () => (await sessions.status(instance.instanceId, "owner-session", started.flowId!)).phase, { timeout: 10_000, interval: 100 }).toBe("failed");
    expect(await sessions.status(instance.instanceId, "owner-session", started.flowId!)).toMatchObject({ reason: "exited" });
    settle();
    expect(power.report()).toMatchObject({ idle: true, busy: [] });
    expect(trace.summary().engines[0].last).toMatchObject({ outcome: "exited" });
    for (const secret of secrets()) expect(written()).not.toContain(secret);
  }, 30_000);

  it("Codex: a code nobody enters expires by itself and lets it sleep, recorded as expired with no one polling", async () => {
    const instance = codex({ lifetimeMs: 1_500 });
    await sessions.start(instance, "owner-session");
    settle();
    expect(busy()).toEqual(["maintenance"]);
    // Nobody reads the status: the power report alone notices the expiry.
    await expect.poll(() => busy(), { timeout: 15_000, interval: 100 }).not.toContain("maintenance");
    await expect.poll(() => trace.summary().engines[0]?.last?.outcome, { timeout: 5_000, interval: 50 }).toBe("expired");
    settle();
    expect(power.report()).toMatchObject({ idle: true, busy: [] });
  }, 30_000);

  it("Claude: a paste-code screen left open expires by itself, though its screen never polls", async () => {
    const instance = claude({ lifetimeMs: 1_500 });
    await sessions.start(instance, "owner-session");
    settle();
    expect(busy()).toEqual(["maintenance"]);
    await expect.poll(() => busy(), { timeout: 15_000, interval: 100 }).not.toContain("maintenance");
    await expect.poll(() => trace.summary().engines[0]?.last?.outcome, { timeout: 5_000, interval: 50 }).toBe("expired");
    expect(trace.summary().open).toBe(0);
  }, 30_000);
});
