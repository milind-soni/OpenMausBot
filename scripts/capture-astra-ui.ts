// Pictures of Astra itself: the real renderer against the disposable fixture.
//
// docs/screenshots/ holds the app's product shots, taken by hand on a live
// workspace. That is right for a README and useless as evidence — nobody can
// re-run them, and they contain whatever happened to be in that workspace. This
// recipe photographs the app the way the rest of the UI fixtures prove a
// surface: a disposable home, the fake engine, and a conversation this run
// created, so every element in the frame is reproducible and nothing real is in
// it. The clock is real, so a re-run matches in content rather than in bytes.
//
//   node --experimental-strip-types scripts/capture-astra-ui.ts
//
// The page is the shipped <App/> (scripts/testing/threads-preview.tsx) — the
// same entry the control surface's `ui launch` serves — and the turns are sent
// through the shared control core, not by typing into the screen. Set
// ASTRA_CAPTURE_CHROME to override the browser. Pictures land in
// docs/verification/evidence/astra-app/ with a findings.json beside them.
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runControlOmb, launchVerificationServer } from "./control-astra.ts";
import {
  closeChrome,
  launchChrome,
  openCdpPage,
  settle,
  type ChromeSession,
  type CdpPage,
} from "./testing/chrome-capture.ts";
import { mountPreview } from "./testing/preview-fixture.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EVIDENCE_DIR = join(REPO_ROOT, "docs", "verification", "evidence", "astra-app");
const READY_TIMEOUT_MS = 120_000;
/** The renderer must catch up with the server; the data-mid row is the proof. */
const RENDER_TIMEOUT_MS = 60_000;

const WHAT_I_ASKED =
  "Walk me through what the voice pipeline does now, and flag anything that worries you.";
const WHAT_IT_ANSWERED = [
  "**Voice pipeline, end to end**",
  "",
  "- Dictation is decoded on this machine: Handy owns the model, and Astra hands it a finished WAV.",
  "- Piper installs from Settings in one click, and every artifact is checked against a pinned SHA-256 before it is unpacked.",
  "- The engine lands last, so an interrupted install reports *not installed* rather than half-working.",
  "",
  "`POST /api/tts/speak` returns real WAV bytes from the installed voice, and no audio leaves the machine.",
].join("\n");

/** The sidebar as the product shows it. The app opens the *newest* bot, so the
 * one holding the conversation is created last — which also puts it at the top
 * of the (newest-first) sidebar, where a real user would find it. */
const AGENTS: Array<{ name: string; title: string }> = [
  { name: "Scout", title: "Research" },
  { name: "Ledger", title: "Numbers" },
  { name: "Astra", title: "Chief of staff" },
];
/** The control core returns the created bot wrapped differently per tool; read
 * the id wherever it is rather than pinning a shape that may drift. */
function createdBotId(result: unknown): string {
  const record = (result ?? {}) as Record<string, unknown>;
  const candidates = [record.bot, record.created, record, record.data];
  for (const candidate of candidates) {
    const id = (candidate as Record<string, unknown> | undefined)?.id;
    if (typeof id === "string" && id) return id;
  }
  throw new Error(`could not read the created bot's id from ${JSON.stringify(result).slice(0, 300)}`);
}

// The fixture's engine is a scripted CLI, so the picture shows an answer this
// recipe wrote. It is never presented as a model's own words. Only FAKE_CLAUDE_*
// crosses from this process into the fixture, which is why the reply is set
// here rather than passed to the launcher.
process.env.FAKE_CLAUDE_REPLIES = JSON.stringify([WHAT_IT_ANSWERED]);
const fixture = await launchVerificationServer();
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
let chrome: ChromeSession | undefined;
let page: CdpPage | undefined;
const findings: string[] = [];
const screenshots: Array<{ state: string; file: string; bytes: number }> = [];

const fail = (message: string): never => {
  throw new Error(message);
};

try {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const base = fixture.info.url;

  // 1. A workspace worth photographing, built through the shared control core.
  const bots: Array<{ id: string; name: string }> = [];
  for (const agent of AGENTS) {
    const created = await runControlOmb([
      "new-bot",
      "--name",
      agent.name,
      "--title",
      agent.title,
      "--url",
      base,
    ]);
    bots.push({ id: createdBotId(created), name: agent.name });
  }
  const front = bots[bots.length - 1]!;
  findings.push(`created ${bots.map((bot) => `${bot.name} (${bot.id})`).join(", ")} in the fixture`);

  // 2. One real turn, sent the same way an external client would.
  await runControlOmb(["send", "--bot", front.id, "--text", WHAT_I_ASKED, "--url", base]);
  const settled = (await runControlOmb(["wait", "--bot", front.id, "--timeout", "60", "--url", base])) as {
    status?: string;
    messages?: Array<{ id?: string; kind?: string }>;
  };
  if (settled.status !== "settled") fail(`the turn did not settle: ${JSON.stringify(settled).slice(0, 300)}`);
  const messages = settled.messages ?? [];
  const newest = [...messages].reverse().find((message) => message.kind === "text" && typeof message.id === "string");
  if (!newest?.id) fail(`the settled turn reported no text message to wait for: ${JSON.stringify(messages).slice(0, 300)}`);
  findings.push(
    `the fixture answered through the fake engine: ${messages.length} message(s) on ${front.name}, newest ${newest.id}`,
  );
// 3. The real renderer, on that same fixture. The entry is the shipped <App/>,
  //    so the sidebar, transcript, composer and skins are the product's own.
  preview = await mountPreview(fixture, {
    entry: "/scripts/testing/threads-preview.tsx",
    route: "/__threads.html",
    title: "Isolated Astra Chat",
  });
  chrome = await launchChrome();
  page = await openCdpPage(chrome);

  const shot = async (state: string, name: string) => {
    const file = join(EVIDENCE_DIR, name);
    const bytes = await page!.shot(file);
    if (bytes < 20_000) fail(`${name} is only ${bytes} bytes — the app probably did not render`);
    screenshots.push({ state, file, bytes });
    findings.push(`${state}: ${name} (${bytes} bytes)`);
  };
  // The transcript row the server just created, by its own id: proof the frame
  // is the conversation and not an empty shell that happened to paint first.
  const newestRow = `!!document.querySelector('[data-mid=${JSON.stringify(newest.id)}]')`;
  // The transcript paints before the app's own chrome does: the model chip shows
  // the raw id until the model list arrives, so wait for a chip carrying a real
  // model name before framing the app.
  const modelChip = `[...document.querySelectorAll("button")].some((button) => /^Claude\\s/.test((button.getAttribute("aria-label") || button.textContent || "").trim()))`;

  await page.navigate(preview.previewUrl);
  // The sidebar row is found by the app's own accessible name for a chat's
  // actions menu, which is stable where a class or a text match is not.
  await page.waitFor(
    `!!document.querySelector('[aria-label=${JSON.stringify(`Actions for ${front.name}`)}]')`,
    READY_TIMEOUT_MS,
    `the sidebar to list ${front.name}`,
  );
  try {
    await page.waitFor(newestRow, RENDER_TIMEOUT_MS, "the newest message row");
  } catch {
    // The app opens the newest bot. If that ever stops being true, say what the
    // sidebar actually holds rather than photographing the wrong conversation.
    const labels = await page.evaluate<string[]>(
      `[...document.querySelectorAll("[aria-label^='Actions for']")].map((el) => el.getAttribute("aria-label"))`,
    );
    fail(`${front.name}'s conversation is not open — the sidebar shows ${JSON.stringify(labels)}`);
  }
  await page.waitFor(modelChip, RENDER_TIMEOUT_MS, "the model chip to resolve");
  findings.push(
    `the frame was checked before the shutter: the sidebar row for ${front.name}, the newest transcript row (data-mid ${newest.id}) and a resolved model chip were all on screen`,
  );
  await settle(page);
  await shot("Astra, dark (default skin)", "astra-app-dark.png");

  // The skin is read from storage at boot, so the light picture is a reload —
  // exactly what a user gets after picking it in Settings.
  await page.evaluate(`localStorage.setItem("omb-skin", "atelier")`);
  await page.navigate(preview.previewUrl);
  await page.waitFor(newestRow, RENDER_TIMEOUT_MS, "the same conversation under the light skin");
  await page.waitFor(modelChip, RENDER_TIMEOUT_MS, "the model chip to resolve again");
  findings.push("the light picture is the same page reloaded with omb-skin=atelier");
  await settle(page);
  await shot("Astra, light (Atelier)", "astra-app-light.png");

  const report = {
    ok: true,
    platform: process.platform,
    url: fixture.info.url,
    dataDir: fixture.info.dataDir,
    logPath: fixture.info.logPath,
    previewUrl: preview.previewUrl,
    chrome: chrome.binary,
    newestMessageId: newest.id,
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

