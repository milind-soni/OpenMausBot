// Pictures of the finished voice surfaces, taken from the real renderer on the
// standard isolated fixture (disposable home, fake engine, no user data).
//
// Two panels in this feature are documented as "a manual check" and "not driven
// by the harness", because neither can be reached from the control surface: the
// Handy engine readout is drawn from data the Electron shell collects, and the
// Piper offer is a panel inside another panel. This recipe closes that gap the
// way the other UI fixtures do — it mounts the shipped components in an
// isolated page, drives them headlessly, and keeps the pictures as evidence.
//
// The only synthesized part is the desktop bridge (see voice-preview.tsx). The
// Handy snapshot handed to it is measured here through the shell's own
// electron/handy-engine.mjs, so a machine with Handy installed photographs its
// real selected model, its real models folder and its real catalog.
//
//   node --experimental-strip-types scripts/verify-voice-ui.ts
//
// Chrome is driven over CDP through Node's built-in WebSocket, so this adds no
// dependency; the browser and the page live in scripts/testing/chrome-capture.ts,
// which the app-wide capture recipe shares. Set ASTRA_CAPTURE_CHROME to a
// Chromium binary to override the usual install locations. Pictures land in
// docs/verification/evidence/voice/ with a findings.json beside them, and
// everything asserted is printed.
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { handyDataDir, readHandyCatalog, readHandyEngine } from "../electron/handy-engine.mjs";
import { launchVerificationServer } from "./control-astra.ts";
import {
  closeChrome,
  launchChrome,
  openCdpPage,
  settle,
  type CdpPage,
  type ChromeSession,
} from "./testing/chrome-capture.ts";
import { mountPreview } from "./testing/preview-fixture.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EVIDENCE_DIR = join(REPO_ROOT, "docs", "verification", "evidence", "voice");
/** The first load transforms the whole renderer through Vite. */
const READY_TIMEOUT_MS = 120_000;
/** The one-click install downloads ~80 MB. */
const INSTALL_TIMEOUT_MS = 300_000;

/** Handy's readout, measured the way the shell measures it: the real selected
 * model, the real models folder and Handy's own catalog. Null when this machine
 * has no Handy, which the panel then reports as missing. */
async function handySnapshot() {
  const environment = {
    home: homedir(),
    platform: process.platform,
    appData: process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    env: process.env,
    exists: existsSync,
  };
  const installed = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Handy", "handy.exe");
  // The path a user sets in Settings when Handy's installer left it off PATH —
  // the common Windows case, and the one this machine is in.
  const handyPath = existsSync(installed) ? installed : "";
  const engine = await readHandyEngine({ handyPath, dataDir: handyDataDir(environment), environment });
  if (!engine.found) return null;
  const run = (exe: string, args: string[], timeoutMs: number) =>
    new Promise<string>((resolve, reject) => {
      execFile(exe, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) =>
        error ? reject(error) : resolve(typeof stdout === "string" ? stdout : ""),
      );
    });
  return { ...engine, catalog: await readHandyCatalog({ exe: engine.exe, run, timeoutMs: 20_000 }) };
}

const fixture = await launchVerificationServer();
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
let chrome: ChromeSession | undefined;
let page: CdpPage | undefined;
const findings: string[] = [];
const screenshots: Array<{ state: string; file: string; bytes: number }> = [];
let installMode = "not attempted";

const fail = (message: string): never => {
  throw new Error(message);
};

try {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const handy = await handySnapshot();
  findings.push(
    handy
      ? `Handy readout source: the real install at ${handy.exe} — selected ${handy.selected ?? "unknown"}, ${handy.installed.length} model folder(s) on disk, ${handy.catalog.length} catalog entries (${handy.catalog.filter((model) => model.downloaded).length} downloaded)`
      : "no Handy on this machine: the readout reports it as missing instead of inventing an install",
  );

  preview = await mountPreview(fixture, {
    entry: "/scripts/testing/voice-preview.tsx",
    route: "/__voice.html",
    title: "Astra · Voice preview",
    extraRoutes: [
      {
        path: "/__fixture/handy.json",
        method: "GET",
        handler: (_req, res) => {
          // Absent means this machine has no Handy: the bridge stays absent and
          // the readout does not render, exactly as in a plain browser.
          if (!handy) {
            res.statusCode = 404;
            res.end("{}");
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(handy));
        },
      },
    ],
  });

  chrome = await launchChrome();
  page = await openCdpPage(chrome);
  const shot = async (state: string, name: string) => {
    const file = join(EVIDENCE_DIR, name);
    const bytes = await page!.shot(file);
    if (bytes < 20_000) fail(`${name} is only ${bytes} bytes — the preview probably did not render`);
    screenshots.push({ state, file, bytes });
    findings.push(`${state}: ${name} (${bytes} bytes)`);
  };

  await page.navigate(preview.previewUrl);
  await page.waitFor("!!window.__voicePreview", READY_TIMEOUT_MS, "the preview page handle");

  // 1. The wake-word card, which now carries the Handy engine readout. The
  //    panel asks the bridge for it, so waiting for its title proves the
  //    snapshot travelled the whole way rather than that a page loaded.
  await page.waitFor(
    `!!document.body.textContent?.includes("Dictation engine")`,
    READY_TIMEOUT_MS,
    "the Handy engine readout to render",
  );
  if (handy?.selected) {
    const label = handy.catalog.find((model) => model.id === handy.selected)?.name ?? handy.selected;
    const shown = await page.evaluate<boolean>(`document.body.textContent.includes(${JSON.stringify(label)})`);
    if (!shown) fail(`the readout does not show Handy's selected model as ${label}`);
    findings.push(`readout names Handy's selected model the way Handy does: ${label}`);
  }
  if (handy && handy.installed.length) {
    // The readout names what Handy can actually *run*. With a catalog it lists
    // the downloaded entries by their catalog names, because a models-directory
    // folder name is not an id `--model` accepts: this machine has
    // `parakeet-tdt-0.6b-v2-int8` on disk while the runnable id is
    // `parakeet-tdt-0.6b-v2` ("Parakeet V2").
    const downloaded = handy.catalog.filter((model) => model.downloaded);
    const runnable = handy.catalog.length ? downloaded.map((model) => model.name) : handy.installed;
    if (runnable.length) {
      const listed = await page.evaluate<boolean>(
        `document.body.textContent.includes(${JSON.stringify(runnable[0])})`,
      );
      if (!listed) fail(`the readout does not list ${runnable[0]} among the models on this computer`);
      findings.push(`readout lists the models it can run: ${runnable.join(", ")}`);
      if (!handy.installed.every((folder) => runnable.includes(folder))) {
        findings.push(
          `the readout does not print folder names: ${handy.installed.join(", ")} on disk ${handy.installed.length === 1 ? "is" : "are"} not an id --model accepts, so Handy's own catalog names are shown instead`,
        );
      }
    }
  }
  const advice = await page.evaluate<boolean>(`document.body.textContent.includes("This computer (")`);
  if (!advice) fail("the readout did not render its hardware advice");
  findings.push("readout rendered the machine's own advice line and its installed/not-installed verdict");
  await page.evaluate("window.__voicePreview.scrollTo('Dictation engine')");
  await settle(page);
  await shot("Handy engine readout (dark)", "handy-engine-dark.png");
  await page.evaluate("window.__voicePreview.skin('atelier')");
  await settle(page);
  await shot("Handy engine readout (light)", "handy-engine-light.png");
  await page.evaluate("window.__voicePreview.skin('midnight')");
  await settle(page);
  // 2. The agent voice panel: the engine radios plus the one-click offer. The
  //    fixture home has no Piper, so the offer must be there, and the engine
  //    must be selectable-but-honest about it.
  await page.evaluate("window.__voicePreview.show('agent')");
  await page.waitFor(
    `!!document.querySelector("[role=radiogroup][aria-label='Voice engine']")`,
    READY_TIMEOUT_MS,
    "the voice engine panel",
  );
  const before = (await fetch(`${fixture.info.url}/api/config`).then((response) => response.json())) as {
    tts?: { piperAvailable?: boolean; piperInstallable?: boolean; provider?: string };
  };
  const offered = await page.evaluate<boolean>(
    `[...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Install Piper")`,
  );
  if (!offered) fail("the agent panel does not offer the Piper install");
  if (before.tts?.piperAvailable === true) fail("the fixture already has an engine, so the offer cannot be pictured");
  if (before.tts?.piperInstallable !== true) {
    fail(`this platform reports no installable Piper build: ${JSON.stringify(before.tts)}`);
  }
  findings.push(
    `piper before the install: available=${before.tts.piperAvailable} installable=${before.tts.piperInstallable}`,
  );
  await shot("the one-click Piper offer", "piper-install-offer.png");

  // 3. The install itself: one click, the button reports the work while the
  //    download runs in the background, and the config frame carries the end.
  if (!(await page.evaluate<boolean>(`window.__voicePreview.click("Install Piper")`))) {
    fail("the Install Piper button could not be clicked");
  }
  await page.waitFor(
    `[...document.querySelectorAll("button")].some((button) => button.textContent.trim().startsWith("Installing Piper"))`,
    30_000,
    "the installing state",
  );
  await shot("Piper installing, from that same button", "piper-installing.png");

  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  let installError: string | null = null;
  let available = false;
  while (Date.now() < deadline) {
    const status = (await fetch(`${fixture.info.url}/api/config`).then((response) => response.json())) as {
      tts?: { piperAvailable?: boolean; piperInstallError?: string | null };
    };
    if (status.tts?.piperAvailable === true) {
      available = true;
      break;
    }
    installError = status.tts?.piperInstallError ?? null;
    if (installError) break;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  if (available) {
    installMode = "one-click download inside the fixture";
    findings.push("the one-click install finished: tts.piperAvailable is true with no error, the host untouched");
  } else {
    // An offline machine still gets the picture, by the route the docs already
    // allow: copy a provisioned piper/ into the printed dataDir, since
    // availability is evaluated per request.
    installMode = "offline copy of the host's install";
    const source = join(homedir(), ".astra", "piper");
    const engine = join(source, process.platform === "win32" ? "piper.exe" : "piper");
    if (!existsSync(engine)) {
      fail(`the install did not finish (${installError ?? "timed out"}) and ${source} has no engine to copy`);
    }
    await cp(source, join(fixture.info.dataDir, "piper"), { recursive: true });
    findings.push(
      `the download path did not finish (${installError ?? "timed out"}); copied the provisioned ${source} into the fixture data dir instead — the offline route the voice docs describe`,
    );
    const repaired = (await fetch(`${fixture.info.url}/api/config`).then((response) => response.json())) as {
      tts?: { piperAvailable?: boolean };
    };
    if (repaired.tts?.piperAvailable !== true) fail("the copied engine is not reported as available");
  }

  // 4. Piper as the engine in use: selecting it in the panel is the real user
  //    action and the real config write, so the picture follows the app's own
  //    path rather than a config file edited behind its back.
  if (!(await page.evaluate<boolean>(`window.__voicePreview.click("Piper")`))) {
    fail("the Piper radio could not be clicked");
  }
  await page.waitFor(
    `document.querySelector("[role=radiogroup][aria-label='Voice engine'] [aria-checked='true']")?.textContent.includes("Piper") === true`,
    60_000,
    "the panel to show Piper as the engine in use",
  );
  const voices = (await fetch(`${fixture.info.url}/api/tts/voices`).then((response) => response.json())) as {
    voices?: Array<{ id: string; label: string; description?: string }>;
  };
  if (!voices.voices?.length) fail("the installed Piper reports no voices");
  findings.push(
    `voices the panel can choose: ${voices.voices
      .map((voice) => `${voice.id} (${voice.label}${voice.description ? `, ${voice.description}` : ""})`)
      .join(", ")}`,
  );
  await settle(page);
  await shot("Piper installed and in use", "piper-installed.png");

  // The picture is only worth keeping if the engine it shows can actually
  // speak, so ask the fixture to synthesize through it and require WAV bytes.
  const spoken = await fetch(`${fixture.info.url}/api/tts/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Piper is installed, and this is the voice.", voiceId: "en_US-amy-medium" }),
  });
  if (!spoken.ok) fail(`/api/tts/speak through the installed Piper → ${spoken.status}: ${await spoken.text()}`);
  const wav = Buffer.from(await spoken.arrayBuffer());
  if (wav.length < 44 || wav.subarray(0, 4).toString() !== "RIFF") {
    fail(`the installed Piper returned ${wav.length} bytes without a WAV header`);
  }
  const sampleRate = wav.readUInt32LE(24);
  findings.push(
    `the pictured engine speaks: a real ${wav.length}-byte ${(sampleRate / 1000).toFixed(2)} kHz WAV (${((wav.length - 44) / (sampleRate * 2)).toFixed(2)}s) from /api/tts/speak`,
  );
  const report = {
    ok: true,
    platform: process.platform,
    url: fixture.info.url,
    dataDir: fixture.info.dataDir,
    logPath: fixture.info.logPath,
    previewUrl: preview.previewUrl,
    chrome: chrome?.binary ?? "",
    installMode,
    screenshots,
    findings,
  };
  writeFileSync(join(EVIDENCE_DIR, "findings.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    page?.close();
  } finally {
    await closeChrome(chrome);
    try {
      await preview?.close();
    } finally {
      await fixture.close();
    }
  }
}
