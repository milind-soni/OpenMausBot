#!/usr/bin/env -S node --experimental-strip-types
// A small command line over the omb-cdp driver, with a throwaway profile and no
// gate. `bot-tests` visits the four public bot-detection pages read-only (no
// sign-in, no form submit) while the driver acts on each, and prints their
// verdicts; it exits non-zero unless all four pass.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { CdpBrowser } from "../server/browser/cdp/browser.ts";
import { tracingTransport, type SentCommand } from "../server/browser/cdp/transport.ts";
import { calibrateIdentity, type CalibratedIdentity } from "../server/browser/chrome/calibrate.ts";
import { SERVER_SCREEN, type HostKind, type ScreenSpec } from "../server/browser/chrome/flags.ts";
import { sandboxDisabled } from "../server/browser/chrome/host-setup.ts";
import { launchChrome } from "../server/browser/chrome/launch.ts";

const USAGE = `usage:
  node --experimental-strip-types scripts/omb-browser.ts bot-tests --chrome PATH [--screen 1512x982@2:30] [--host desktop|server|container] [--out DIR] [--label NAME]
  node --experimental-strip-types scripts/omb-browser.ts snapshot URL --chrome PATH
  node --experimental-strip-types scripts/omb-browser.ts calibrate --chrome PATH
The Chrome path may also come from OMB_CHROME_PATH. OMB_BROWSER_SANDBOX=0 is an operator's explicit opt-out of Chrome's sandbox.`;

interface Site {
  name: "sannysoft" | "creepjs" | "browserscan" | "deviceandbrowserinfo";
  url: string;
  settleMs: number;
  extract: string;
}

/** Read-only extractors: they only read the DOM, in the isolated world. */
const SITES: Site[] = [
  {
    name: "sannysoft",
    url: "https://bot.sannysoft.com",
    settleMs: 8_000,
    extract: `(() => { const rows = [...document.querySelectorAll("table tr")].map((tr) => { const cells = tr.cells; if (!cells || cells.length < 2) return null; const last = cells[cells.length - 1]; return { test: cells[0].innerText.trim(), result: last.innerText.trim().slice(0, 160), cls: last.className }; }).filter(Boolean); return { failed: rows.filter((row) => /failed/.test(row.cls)), warn: rows.filter((row) => /warn/.test(row.cls)), passed: rows.filter((row) => /passed/.test(row.cls)).length, total: rows.length }; })()`,
  },
  {
    name: "creepjs",
    url: "https://abrahamjuliot.github.io/creepjs/",
    settleMs: 18_000,
    extract: `(() => document.body.innerText.split("\\n").map((line) => line.trim()).filter((line) => /headless|stealth|trust score|lies/i.test(line)).slice(0, 80))()`,
  },
  {
    name: "browserscan",
    url: "https://www.browserscan.net/bot-detection",
    settleMs: 14_000,
    extract: `document.body.innerText.slice(0, 12000)`,
  },
  {
    name: "deviceandbrowserinfo",
    url: "https://deviceandbrowserinfo.com/are_you_a_bot",
    settleMs: 12_000,
    extract: `document.body.innerText.slice(0, 15000)`,
  },
];

export interface Verdict {
  site: Site["name"];
  pass: boolean;
  detail: string;
}

/** The pass rules: no failed sannysoft row; CreepJS 0% headless and 0% stealth; browserscan "Normal"; deviceandbrowserinfo isBot false. */
export function verdict(site: Site["name"], extracted: unknown): Verdict {
  if (site === "sannysoft") {
    const value = extracted as { failed?: Array<{ test: string }>; passed?: number; total?: number } | null;
    if (!value?.total) return { site, pass: false, detail: "no result table" };
    const failed = (value.failed ?? []).map((row) => row.test.replace(/\s+/g, " "));
    return { site, pass: failed.length === 0, detail: `${value.passed}/${value.total} rows passed${failed.length ? `; failed: ${failed.join(", ")}` : ""}` };
  }
  if (site === "creepjs") {
    const lines = Array.isArray(extracted) ? extracted.map(String) : [];
    const score = (label: string) => {
      const match = lines.map((line) => new RegExp(`^(\\d+)% ${label}(?::|$)`).exec(line)).find(Boolean);
      return match ? Number(match[1]) : null;
    };
    const headless = score("headless");
    const stealth = score("stealth");
    const like = score("like headless");
    if (headless === null || stealth === null) return { site, pass: false, detail: "no headless or stealth score on the page" };
    return { site, pass: headless === 0 && stealth === 0, detail: `headless ${headless}%, stealth ${stealth}%, like headless ${like ?? "?"}%` };
  }
  const text = typeof extracted === "string" ? extracted : "";
  if (site === "browserscan") {
    const result = /Test Results:\s*\n\s*(\w+)/.exec(text)?.[1] ?? null;
    return { site, pass: result === "Normal", detail: result ?? "no test result on the page" };
  }
  const json = /\{\s*"isBot".*?\n\}/s.exec(text)?.[0];
  if (!json) return { site, pass: false, detail: "no isBot verdict on the page" };
  try {
    const parsed = JSON.parse(json) as { isBot: boolean; details?: Record<string, boolean> };
    const flagged = Object.entries(parsed.details ?? {}).filter(([, value]) => value).map(([key]) => key);
    return { site, pass: parsed.isBot === false, detail: `isBot=${parsed.isBot}${flagged.length ? `; ${flagged.join(", ")}` : ""}` };
  } catch {
    return { site, pass: false, detail: "unreadable isBot verdict" };
  }
}

function parseScreen(text: string | undefined): ScreenSpec {
  if (!text) return SERVER_SCREEN;
  const match = /^(\d+)x(\d+)(?:@([\d.]+))?(?::(\d+))?$/.exec(text);
  if (!match) throw new Error(`--screen takes WIDTHxHEIGHT[@SCALE][:DEPTH], e.g. 1512x982@2:30, not ${text}`);
  return { width: Number(match[1]), height: Number(match[2]), deviceScaleFactor: Number(match[3] ?? 1), ...(match[4] ? { colorDepth: Number(match[4]) } : {}) };
}

const FORBIDDEN = /^(?:Runtime\.enable|Runtime\.addBinding|Console\.\w+|Debugger\.\w+|Profiler\.\w+|HeapProfiler\.\w+)$/;

interface Session {
  browser: CdpBrowser;
  sent: SentCommand[];
  close(): Promise<void>;
}

async function start(chrome: string, host: HostKind, screen: ScreenSpec, identity: CalibratedIdentity | null, workDir: string): Promise<Session> {
  const launched = await launchChrome({
    executablePath: chrome,
    userDataDir: join(workDir, "profile"),
    mode: "headless",
    host,
    userAgent: identity?.userAgent ?? null,
    screen,
    locale: "en-US",
    sandbox: !sandboxDisabled(process.env),
  });
  const sent: SentCommand[] = [];
  const browser = await CdpBrowser.connect(tracingTransport(launched.transport, (command) => sent.push(command)), {
    identity,
    acceptLanguage: "en-US,en",
    downloadDir: join(workDir, "downloads"),
  });
  return {
    browser,
    sent,
    async close() {
      await browser.close().catch(() => {});
      await launched.close(3_000);
    },
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function botTests(chrome: string, options: { host: HostKind; screen: ScreenSpec; out: string; label: string }): Promise<boolean> {
  mkdirSync(options.out, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "omb-browser-"));
  try {
    const identity = await calibrateIdentity({ executablePath: chrome, host: options.host, tmpRoot: workDir, sandbox: !sandboxDisabled(process.env) });
    console.log(`identity: ${identity.userAgent}\n  ${identity.userAgentMetadata.fullVersionList.map((brand) => `${brand.brand} ${brand.version}`).join(", ")}; ${identity.userAgentMetadata.platform} ${identity.userAgentMetadata.platformVersion} ${identity.userAgentMetadata.architecture}`);
    const session = await start(chrome, options.host, options.screen, identity, workDir);
    const verdicts: Verdict[] = [];
    try {
      const page = await session.browser.waitForPage();
      for (const site of SITES) {
        const started = Date.now();
        await page.navigate(site.url, { readiness: "load", timeoutMs: 45_000 }).catch((error: unknown) => console.log(`  ${site.name}: ${error instanceof Error ? error.message : String(error)}`));
        const until = Date.now() + site.settleMs;
        while (Date.now() < until) {
          // The agent acts while the page tests it: a snapshot every couple of seconds.
          await page.snapshot().catch(() => {});
          await sleep(2_000);
        }
        const extracted = await page.evaluate(site.extract, { timeoutMs: 10_000 }).catch((error: unknown) => ({ error: String(error) }));
        const shot = await page.screenshot().catch(() => null);
        if (shot) writeFileSync(join(options.out, `${options.label}.${site.name}.png`), shot.data);
        writeFileSync(join(options.out, `${options.label}.${site.name}.json`), `${JSON.stringify(extracted, null, 2)}\n`);
        const result = verdict(site.name, extracted);
        verdicts.push(result);
        console.log(`  ${result.pass ? "PASS" : "FAIL"}  ${site.name.padEnd(21)} ${result.detail}  (${Date.now() - started} ms)`);
      }
    } finally {
      await session.close();
    }
    const counts: Record<string, number> = {};
    for (const command of session.sent) counts[command.method] = (counts[command.method] ?? 0) + 1;
    const forbidden = Object.keys(counts).filter((method) => FORBIDDEN.test(method));
    const passed = verdicts.filter((entry) => entry.pass).length;
    writeFileSync(join(options.out, `${options.label}.summary.json`), `${JSON.stringify({ label: options.label, chrome, identity, verdicts, commandsSent: counts }, null, 2)}\n`);
    console.log(`${passed}/${SITES.length} pass; ${session.sent.length} CDP commands sent, forbidden: ${forbidden.length ? forbidden.join(", ") : "none"}`);
    console.log(`results: ${resolve(options.out)}`);
    return passed === SITES.length && forbidden.length === 0;
  } finally {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function snapshot(chrome: string, url: string, host: HostKind): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "omb-browser-"));
  try {
    const session = await start(chrome, host, SERVER_SCREEN, null, workDir);
    try {
      const page = await session.browser.waitForPage();
      await page.navigate(url, { timeoutMs: 30_000 });
      const result = await page.snapshot();
      console.log(`${result.title} — ${result.url}\n${result.tree}`);
    } finally {
      await session.close();
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      chrome: { type: "string" },
      screen: { type: "string" },
      host: { type: "string" },
      out: { type: "string" },
      label: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, url] = positionals;
  const chrome = values.chrome ?? process.env.OMB_CHROME_PATH;
  if (values.help || !command || !chrome) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const host: HostKind = values.host === "server" || values.host === "container" ? values.host : "desktop";
  if (command === "bot-tests") {
    const ok = await botTests(chrome, { host, screen: parseScreen(values.screen), out: values.out ?? join(process.cwd(), ".omb-scratch", "bot-tests"), label: values.label ?? "omb-cdp" });
    return ok ? 0 : 1;
  }
  if (command === "snapshot" && url) {
    await snapshot(chrome, url, host);
    return 0;
  }
  if (command === "calibrate") {
    const workDir = mkdtempSync(join(tmpdir(), "omb-browser-"));
    try {
      console.log(JSON.stringify(await calibrateIdentity({ executablePath: chrome, host, tmpRoot: workDir, sandbox: !sandboxDisabled(process.env) }), null, 2));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
    return 0;
  }
  console.log(USAGE);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
