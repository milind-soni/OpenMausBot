// What sites see of a bot's browser: today's engine (agent-browser) drives the Chrome OMB resolves, through the same launcher
// and identity connection as the server, on a throwaway profile. It checks the identity on a loopback probe page and, with
// --public, reads the four public bot-test pages. Read-only: it never signs in or submits a form.
// Usage: node --experimental-strip-types scripts/verify-browser-identity.ts [--chrome PATH] [--engine PATH] [--public] [--out DIR]
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { agentBrowserDevToolsPorts, agentBrowserIntegration, closeBrowserSession, prepareBrowserSessionState, resolveAgentBrowserBinary, runningBrowserSessionNames, setBrowserViewport } from "../server/browser-engine.ts";
import { BrowserRuntime, browserRuntimeEnv, type BrowserSpawnSpec } from "../server/browser-runtime.ts";
import { ChromeLauncher } from "../server/browser/chrome/launcher.ts";
import { openGate } from "../server/browser/egress/gate.ts";
import { refusalFor } from "../server/browser/egress/policy.ts";
import { DATA_DIR } from "../server/config.ts";
import { expectedUserAgent, startIdentityProbe, type ProbeReports, type ReportedIdentity } from "./testing/browser-identity-probe.ts";

export const PUBLIC_PAGES = [
  {
    name: "sannysoft", url: "https://bot.sannysoft.com", waitMs: 8_000,
    extract: `(() => { const rows = [...document.querySelectorAll('table tr')].map((tr) => { const c = tr.cells; if (!c || c.length < 2) return null; return { test: c[0].innerText.trim().replace(/\\s+/g, ' '), cls: c[c.length - 1].className }; }).filter(Boolean); return { failed: rows.filter((r) => /failed/.test(r.cls)).map((r) => r.test), warn: rows.filter((r) => /warn/.test(r.cls)).map((r) => r.test), passed: rows.filter((r) => /passed/.test(r.cls)).length, total: rows.length }; })()`,
    verdict: (value: Record<string, unknown>) => {
      const failed = (value.failed as string[] | undefined) ?? [];
      return { pass: Array.isArray(value.failed) && failed.length === 0, detail: `${value.passed}/${value.total} rows passed${failed.length ? `; failed: ${failed.join(", ")}` : ""}` };
    },
  },
  {
    name: "creepjs", url: "https://abrahamjuliot.github.io/creepjs/", waitMs: 18_000,
    extract: `(() => document.body.innerText.split('\\n').map((line) => line.trim()).filter((line) => /^\\d+% (like headless|headless|stealth)/.test(line)))()`,
    verdict: (value: unknown) => {
      const scores: Record<string, number> = {};
      for (const line of Array.isArray(value) ? value as string[] : []) {
        const match = /^(\d+)% (like headless|headless|stealth)/u.exec(line);
        if (match && scores[match[2]!] === undefined) scores[match[2]!] = Number(match[1]);
      }
      return { pass: scores.headless === 0 && scores.stealth === 0, detail: `headless ${scores.headless ?? "?"}%, stealth ${scores.stealth ?? "?"}%, like headless ${scores["like headless"] ?? "?"}%` };
    },
  },
  {
    name: "browserscan", url: "https://www.browserscan.net/bot-detection", waitMs: 14_000,
    extract: `(() => document.body.innerText.slice(0, 12000))()`,
    verdict: (value: unknown) => {
      const text = typeof value === "string" ? value : "";
      const verdict = /Test Results:\s*\n\s*(\w+)/u.exec(text)?.[1] ?? "?";
      const lines = text.split("\n").map((line) => line.trim());
      const robots = lines.flatMap((line, index) => line === "Robot" && index > 0 && lines[index - 1] !== "Test Results:" ? [lines[index - 1]] : []);
      return { pass: verdict === "Normal", detail: `${verdict}${robots.length ? `; robot items: ${robots.join(", ")}` : ""}` };
    },
  },
  {
    name: "deviceandbrowserinfo", url: "https://deviceandbrowserinfo.com/are_you_a_bot", waitMs: 12_000,
    extract: `(() => document.body.innerText.slice(0, 15000))()`,
    verdict: (value: unknown) => {
      const found = /\{\s*"isBot"[\s\S]*?\n\}/u.exec(typeof value === "string" ? value : "")?.[0];
      if (!found) return { pass: false, detail: "no verdict on the page" };
      const parsed = JSON.parse(found) as { isBot: boolean; details?: Record<string, boolean> };
      const flags = Object.entries(parsed.details ?? {}).filter(([, on]) => on).map(([name]) => name);
      return { pass: parsed.isBot === false, detail: `isBot=${parsed.isBot}${flags.length ? `; ${flags.join(", ")}` : ""}` };
    },
  },
] as const;

export interface IdentityReadout {
  chrome: string;
  expectedUserAgent: string;
  reports: ProbeReports;
  checks: Array<{ check: string; pass: boolean; detail: string }>;
}

export interface PublicVerdict { name: string; pass: boolean; detail: string; screenshot?: string }

/** A desktop Chrome reports every high-entropy hint. `model` is empty on desktops, and Chrome on Linux reports no platform
 * version (an empty Sec-CH-UA-Platform-Version), headed or not. */
export function completeHints(high: Record<string, unknown> | null | undefined): boolean {
  if (!high) return false;
  const filled = (name: string) => typeof high[name] === "string" && high[name] !== "";
  const list = (name: string) => Array.isArray(high[name]) && (high[name] as unknown[]).length > 0;
  const version = high.platform === "Linux" ? typeof high.platformVersion === "string" : filled("platformVersion");
  return ["architecture", "bitness", "platform", "uaFullVersion"].every(filled) && version && list("brands") && list("fullVersionList")
    && typeof high.model === "string" && typeof high.mobile === "boolean" && typeof high.wow64 === "boolean";
}

function evalValue(result: unknown): unknown {
  const content = (result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null);
  if (!content || content.isError) throw new Error(`the page read failed: ${JSON.stringify(result).slice(0, 300)}`);
  const text = content.content?.find((part) => part.type === "text")?.text ?? "";
  let value: unknown = JSON.parse(text);
  if (typeof value === "string") { try { value = JSON.parse(value); } catch {} }
  return value && typeof value === "object" && "result" in value ? (value as { result: unknown }).result : value;
}

/** What a failed tool call told the bot, in the engine's words; null when it succeeded. */
function refused(result: unknown): string | null {
  const answer = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;
  if (answer && !answer.isError) return null;
  return answer?.content?.filter((part) => part.type === "text").map((part) => part.text).join(" ") || JSON.stringify(result).slice(0, 300);
}

/**
 * Opens a page of the check's own in the bot's just-started browser. Chrome for Testing 155-156 on Windows now and then
 * cancels a fresh profile's first network navigation (net::ERR_ABORTED, 35 of 150 starts on GitHub's runner), and a
 * second request goes through: the page has no side effects, so it is opened once more after that one cancel. Answers
 * what the bot was told when it failed.
 */
export async function openOwnPageAsBot(call: BotCall, url: string, log: (line: string) => void): Promise<string | null> {
  const navigation = await openIdentityProbePage(call, url, log);
  return navigation.kind === "failed" ? navigation.detail : null;
}

/** The runtime keeps file paths away from the engine, so a screenshot comes back as image content. */
function savedImage(result: unknown, base: string): string | null {
  const image = (result as { content?: Array<{ type?: string; data?: string; mimeType?: string }> } | null)?.content?.find((part) => part.type === "image" && part.data);
  if (!image?.data) return null;
  const file = `${base}.${image.mimeType === "image/jpeg" ? "jpg" : "png"}`;
  writeFileSync(file, Buffer.from(image.data, "base64"));
  return file;
}

/** "en-US,en;q=0.9" → "en-US,en". */
export function headerLanguages(header: string | undefined): string {
  return (header ?? "").split(",").map((part) => part.split(";")[0]!.trim()).filter(Boolean).join(",");
}

export function identityChecks(reports: ProbeReports, expected: string): IdentityReadout["checks"] {
  const places: Array<[string, ReportedIdentity | undefined]> = [["page", reports.page], ["dedicated worker", reports.worker], ["service worker", reports.serviceworker], ["cross-site frame", reports.frame]];
  const page = reports.page;
  const sameHints = (report: ReportedIdentity | undefined) => JSON.stringify(report?.high) === JSON.stringify(page?.high);
  const headers = Object.entries(reports.headers);
  return [
    { check: "page user agent equals the expected string byte for byte", pass: page?.ua === expected, detail: page?.ua ?? "no report" },
    ...places.slice(1).map(([name, report]) => ({ check: `${name} user agent equals it too`, pass: report?.ua === expected, detail: report?.ua ?? "no report" })),
    ...headers.map(([name, picked]) => ({ check: `User-Agent header of the ${name} request equals it too`, pass: picked["user-agent"] === expected, detail: picked["user-agent"] ?? "none" })),
    { check: "page client hints are complete", pass: completeHints(page?.high), detail: JSON.stringify(page?.high ?? null) },
    ...places.slice(1).map(([name, report]) => ({ check: `${name} client hints equal the page's`, pass: Boolean(report?.high) && sameHints(report), detail: JSON.stringify(report?.high ?? null) })),
    { check: "no place reports a headless brand", pass: places.every(([, report]) => !JSON.stringify(report?.brands ?? []).includes("Headless")), detail: JSON.stringify(page?.brands ?? null) },
    { check: "page is 1280x720 inside", pass: page?.inner?.[0] === 1280 && page.inner[1] === 720, detail: `inner ${page?.inner?.join("x")}, outer ${page?.outer?.join("x")}, screen ${page?.screen?.join("x")}, dpr ${page?.dpr}` },
    { check: "navigator.webdriver is false", pass: page?.webdriver === false, detail: String(page?.webdriver) },
    { check: "navigator.languages are the Accept-Language header's, in order", pass: Boolean(page?.languages.length) && page?.languages.join(",") === headerLanguages(reports.headers.document?.["accept-language"]), detail: `${JSON.stringify(page?.languages ?? null)} against ${reports.headers.document?.["accept-language"] ?? "no header"}` },
    { check: "plugins and window.chrome are present", pass: (page?.plugins ?? 0) > 0 && page?.windowChrome === "object", detail: `${page?.plugins} plugins, window.chrome ${page?.windowChrome}` },
  ];
}

export interface BotBrowserOptions {
  engine: string;
  chrome: string;
  out: string;
  sessionPrefix?: string;
  log?: (line: string) => void;
}

export function browserFixtureEnvironment(scratch: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const home = join(scratch, "home");
  if (platform === "win32") {
    return { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") };
  }
  if (platform === "linux") {
    return { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_RUNTIME_DIR: join(scratch, "runtime") };
  }
  return { HOME: home, USERPROFILE: home };
}

type FixtureBrowserShutdown =
  | { kind: "closed"; session: "closed" | "already-closed" }
  | { kind: "unconfirmed"; detail: string; liveDevToolsPorts: number[] };

async function devToolsPortIsLive(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (live: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => finish(false), 500);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function liveFixtureDevToolsPorts(profiles: string): Promise<number[]> {
  const ports = agentBrowserDevToolsPorts(profiles, join(profiles, "saved-profiles"));
  return (await Promise.all(ports.map(async (port) => await devToolsPortIsLive(port) ? port : null))).filter((port): port is number => port !== null);
}

/** A browser tool call, as the bot makes it. */
export type BotCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type IdentityProbeNavigation =
  | { kind: "opened"; attempts: number; result: unknown }
  | { kind: "failed"; attempts: number; result: unknown; detail: string };

export async function openIdentityProbePage(call: BotCall, url: string, log: (line: string) => void = () => {}): Promise<IdentityProbeNavigation> {
  let attempts = 1;
  let result = await call("agent_browser_open", { url });
  let detail = refused(result);
  if (detail && /\bnet::ERR_ABORTED\b/u.test(detail)) {
    log(`the bot's browser: Chrome cancelled its first navigation (${detail}); opening ${url} once more`);
    attempts++;
    result = await call("agent_browser_open", { url });
    detail = refused(result);
  }
  return detail ? { kind: "failed", attempts, result, detail } : { kind: "opened", attempts, result };
}

/** A bot's browser as the server starts it, on a throwaway profile, for as long as `work` runs: agent-browser drives the
 * Chrome named here through the same launcher, identity connection and egress gate. `work` gets the bot's tool calls and
 * the ports the gate let through. */
export async function withBotBrowser<T>(options: BotBrowserOptions, work: (call: BotCall, gated: ReadonlySet<number>, launcher: ChromeLauncher) => Promise<T>): Promise<T> {
  const log = options.log ?? (() => {});
  mkdirSync(options.out, { recursive: true });
  const scratch = mkdtempSync(join(options.out, "run-"));
  const profiles = join(scratch, "tmp");
  mkdirSync(profiles);
  // agent-browser's socket path must stay under 104 bytes; temporary folders on macOS are long.
  const sockets = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "omb-id-"));
  const fixtureEnv = browserFixtureEnvironment(scratch, process.platform);
  // Chrome on macOS needs the real home directory to find its keychain; other platforms keep fixture homes.
  if (process.platform === "darwin") {
    const home = userInfo().homedir;
    fixtureEnv.HOME = home;
    fixtureEnv.USERPROFILE = home;
  }
  const home = fixtureEnv.HOME!;
  mkdirSync(home, { recursive: true });
  for (const path of Object.values(fixtureEnv)) if (path && path !== home) mkdirSync(path, { recursive: true, mode: 0o700 });
  const session = `${options.sessionPrefix ?? "omb-identity"}-${randomBytes(3).toString("hex")}`;
  const launcher = new ChromeLauncher({ dataDir: join(scratch, "data"), env: { ...process.env, ...fixtureEnv, OMB_CHROME_PATH: options.chrome }, log });
  // Where the launcher adds nothing (OMB_BROWSER_LEGACY_SHELL=1, a headless shell), agent-browser would otherwise look for a
  // browser of its own, such as an installed Google Chrome, instead of the one named here.
  const launcherEnv = launcher.env();
  // Like every bot browser, this one browses through an egress gate; desktop rules let it reach loopback pages.
  const decided = new Set<number>();
  const gate = await openGate({ decide: (target, addresses) => {
    decided.add(target.port);
    return refusalFor(target, addresses, { host: "desktop", ownPort: () => false, botPort: async () => false, localNetwork: true, allowed: () => false });
  } });
  const integration = agentBrowserIntegration({
    binaryPath: options.engine, session, encryptionKey: randomBytes(32).toString("hex"), persistent: false, launcher: launcherEnv, egressPort: gate.port,
    env: { PATH: process.env.PATH ?? "", ...fixtureEnv, ...(Object.keys(launcherEnv).length ? {} : { AGENT_BROWSER_EXECUTABLE_PATH: options.chrome }) },
  });
  const spec: BrowserSpawnSpec = { ...integration, env: { ...integration.env, ...fixtureEnv, TMPDIR: profiles, TEMP: profiles, TMP: profiles, AGENT_BROWSER_SOCKET_DIR: sockets } };
  const runtime = new BrowserRuntime({
    launch: launcher, resultBudget: 500_000,
    applyViewport: (value) => setBrowserViewport(value.command, value.env),
    closeBrowser: (name, value) => closeBrowserSession(value.command, browserRuntimeEnv({ ...value.env, AGENT_BROWSER_SESSION: name })),
  });
  let outcome: { kind: "success"; value: T } | { kind: "failure"; error: unknown };
  try {
    await prepareBrowserSessionState(options.engine, session, { env: spec.env, persistent: false });
    await launcher.prepare();
    outcome = { kind: "success", value: await work((name, args) => runtime.agentRpc(session, spec, "tools/call", { name, arguments: args }), decided, launcher) };
  } catch (error) {
    outcome = { kind: "failure", error };
  }

  const cleanupErrors: string[] = [];
  let browserShutdown: FixtureBrowserShutdown = { kind: "unconfirmed", detail: "shutdown was not checked", liveDevToolsPorts: [] };
  try {
    const browserEnv = browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session });
    const sessions = await runningBrowserSessionNames(options.engine, browserEnv);
    const alreadyClosed = sessions !== null && !sessions.includes(session);
    const closed = alreadyClosed || (sessions !== null && await closeBrowserSession(options.engine, browserEnv));
    if (closed) {
      const deadline = Date.now() + 5_000;
      let liveDevToolsPorts = await liveFixtureDevToolsPorts(profiles);
      while (liveDevToolsPorts.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        liveDevToolsPorts = await liveFixtureDevToolsPorts(profiles);
      }
      browserShutdown = liveDevToolsPorts.length
        ? { kind: "unconfirmed", detail: `${alreadyClosed ? "session was already closed" : "session close returned"}, but Chrome still answers on its unique profile`, liveDevToolsPorts }
        : { kind: "closed", session: alreadyClosed ? "already-closed" : "closed" };
    } else {
      browserShutdown = { kind: "unconfirmed", detail: sessions === null ? "could not list running browser sessions" : "agent-browser shutdown was not confirmed", liveDevToolsPorts: await liveFixtureDevToolsPorts(profiles) };
    }
    if (browserShutdown.kind === "unconfirmed") cleanupErrors.push(browserShutdown.detail);
  } catch (error) {
    browserShutdown = { kind: "unconfirmed", detail: `agent-browser shutdown failed: ${error instanceof Error ? error.message : String(error)}`, liveDevToolsPorts: await liveFixtureDevToolsPorts(profiles).catch(() => []) };
    cleanupErrors.push(browserShutdown.detail);
  }
  try {
    await runtime.closeAll();
  } catch (error) {
    cleanupErrors.push(`browser transport shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await gate.close();
  } catch (error) {
    cleanupErrors.push(`egress gate shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const workFailed = outcome.kind === "failure";
  if (browserShutdown.kind === "closed" && cleanupErrors.length === 0 && !workFailed) {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      cleanupErrors.push(`browser profile cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      rmSync(sockets, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`browser socket cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    log(`browser fixture retained at ${scratch}; socket directory retained at ${sockets}`);
  }

  if (cleanupErrors.length) {
    const details = cleanupErrors.join("; ");
    log(`browser fixture cleanup incomplete: ${details}`);
    if (!workFailed) throw new Error(`Browser fixture cleanup failed: ${details}; temporary paths: ${scratch}, ${sockets}`);
  }
  if (outcome.kind === "failure") throw outcome.error;
  return outcome.value;
}

export async function verifyBrowserIdentity(options: BotBrowserOptions & { publicPages?: boolean }): Promise<{ readout: IdentityReadout; public: PublicVerdict[] }> {
  const log = options.log ?? (() => {});
  const probe = await startIdentityProbe();
  try {
    return await withBotBrowser(options, async (call, decided, launcher) => {
      const navigation = await openIdentityProbePage(call, probe.url, log);
      if (navigation.kind === "failed") {
        const probePort = Number(new URL(probe.url).port);
        writeFileSync(join(options.out, "browser-navigation-failure.json"), `${JSON.stringify({ url: probe.url, attempts: navigation.attempts, error: navigation.detail, result: navigation.result, probePort, gatedPorts: [...decided], gateSawProbe: decided.has(probePort) }, null, 2)}\n`);
        throw new Error(`the bot's browser could not open the probe page after ${navigation.attempts} attempt(s): ${navigation.detail}`);
      }
      const reports = await probe.complete(30_000);
      const major = String(reports.page?.high?.uaFullVersion ?? "").split(".")[0] ?? "";
      const expected = expectedUserAgent(major);
      const gated = { check: "the page loaded through the egress gate", pass: decided.has(Number(new URL(probe.url).port)), detail: `the gate decided on ports ${[...decided].join(", ") || "none"}` };
      const readout: IdentityReadout = { chrome: launcher.describe(), expectedUserAgent: expected, reports, checks: [...identityChecks(reports, expected), gated] };
      writeFileSync(join(options.out, "identity.json"), `${JSON.stringify(readout, null, 2)}\n`);
      const verdicts: PublicVerdict[] = [];
      for (const site of options.publicPages ? PUBLIC_PAGES : []) {
        const started = Date.now();
        try {
          await call("agent_browser_open", { url: site.url });
          await new Promise((done) => setTimeout(done, site.waitMs));
          const value = evalValue(await call("agent_browser_eval", { script: `JSON.stringify(${site.extract})` }));
          const screenshot = savedImage(await call("agent_browser_screenshot", {}).catch(() => null), join(options.out, site.name));
          verdicts.push({ name: site.name, ...site.verdict(value as never), ...(screenshot ? { screenshot } : {}) });
        } catch (error) {
          verdicts.push({ name: site.name, pass: false, detail: `could not read the page: ${error instanceof Error ? error.message : String(error)}` });
        }
        log(`${site.name}: ${verdicts.at(-1)!.pass ? "pass" : "FAIL"} (${verdicts.at(-1)!.detail}) in ${Date.now() - started} ms`);
      }
      if (verdicts.length) writeFileSync(join(options.out, "public.json"), `${JSON.stringify(verdicts, null, 2)}\n`);
      return { readout, public: verdicts };
    });
  } finally {
    await probe.close();
  }
}

function printReadout(readout: IdentityReadout, verdicts: PublicVerdict[]): void {
  const page = readout.reports.page;
  console.log(`\nbrowser: ${readout.chrome}`);
  console.log(`expected user agent: ${readout.expectedUserAgent}`);
  for (const { check, pass, detail } of readout.checks) console.log(`${pass ? "pass" : "FAIL"}  ${check}${pass ? "" : `: ${detail}`}`);
  if (page) {
    console.log(`client hints: ${JSON.stringify(page.high)}`);
    console.log(`languages ${page.languages.join(",")}, time zone ${page.timeZone}, scrollbar ${page.scrollbarWidth}px, Error.name reads per console.log ${page.errorNameReadsPerLog} (more than 1: a CDP client enabled Runtime)`);
  }
  if (verdicts.length) {
    console.log(`\npublic bot tests: ${verdicts.filter((verdict) => verdict.pass).length}/${verdicts.length}`);
    for (const verdict of verdicts) console.log(`${verdict.pass ? "pass" : "FAIL"}  ${verdict.name}: ${verdict.detail}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    chrome: { type: "string" }, engine: { type: "string" }, out: { type: "string" }, public: { type: "boolean", default: false }, "session-prefix": { type: "string" },
  } });
  const engine = values.engine ?? resolveAgentBrowserBinary({ dataDir: DATA_DIR });
  if (!engine) throw new Error("No agent-browser found: pass --engine or set OMB_AGENT_BROWSER_PATH.");
  const plan = new ChromeLauncher({ dataDir: DATA_DIR }).plan();
  const chrome = values.chrome ?? (plan.kind === "chrome" ? plan.chrome.path : null);
  if (!chrome) throw new Error(`OMB would not start its own Chrome here (${plan.kind === "legacy" ? plan.reason : "Chrome for Testing is not downloaded yet"}); pass --chrome.`);
  const out = resolve(values.out ?? mkdtempSync(join(tmpdir(), "omb-browser-identity-")));
  const { readout, public: verdicts } = await verifyBrowserIdentity({ engine, chrome, out, publicPages: values.public, sessionPrefix: values["session-prefix"], log: (line) => console.log(line) });
  printReadout(readout, verdicts);
  console.log(`\nresults: ${out}`);
  process.exitCode = readout.checks.every((check) => check.pass) ? 0 : 1;
}
