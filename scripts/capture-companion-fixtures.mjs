#!/usr/bin/env node
// Capture the iOS test fixtures from a real harness.
//
//   node scripts/capture-companion-fixtures.mjs
//
// The fixtures in ios/Tests/CompanionCoreTests/Fixtures are bytes the server
// actually sent. That is the whole point of them: hand-written test JSON
// tests our idea of the API, and the entire risk in a two-language client is
// that our idea drifts from the API without anything failing. Re-running this
// after a server change makes the Swift tests fail if a payload moved, which
// is the alarm we want.
//
// Everything is disposable. A harness is started against a temporary HOME
// with a fabricated profile, so nothing here reads or writes your real
// ~/.openmausbot and no real name, key or token can end up in a fixture. The
// pairing token is redacted on the way out regardless.
//
// One fixture is not captured: options-card.json needs a bot to actually ask
// for approval, which needs a real provider and a real turn. It is left
// alone, and the run says so rather than quietly writing a worse version.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "ios", "Tests", "CompanionCoreTests", "Fixtures");

const base = 19100 + Math.floor(Math.random() * 3000);
const HARNESS_PORT = base;
const COMPANION_PORT = base + 10;
const CONTROL_PORT = base + 11;
const HARNESS = `http://127.0.0.1:${HARNESS_PORT}`;
const SIDECAR = `http://127.0.0.1:${COMPANION_PORT}`;
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

// A profile invented here rather than read from disk, so the fixtures name
// nobody real and stay byte-stable between machines.
const PROFILE = { name: "Ada Lovelace", email: "ada@example.com" };

const children = [];
let home = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const write = (name, value) => {
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  ${name}.json`);
};

/** Start a process and keep its stderr, so a failure to boot says why. */
const start = (label, args, env) => {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (c) => (child.err = (child.err ?? "") + c));
  children.push({ label, child });
  return child;
};

const waitFor = async (url, label, child) => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error(`${label} exited ${child.exitCode}:\n${child.err ?? ""}`);
    if (Date.now() > deadline) throw new Error(`${label} never came up:\n${child.err ?? ""}`);
    await sleep(150);
  }
};

const json = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
};

/** The device token, once pairing has produced one. Everything the phone
 * itself would ask for goes through the sidecar carrying this. */
let deviceToken = "";
const asDevice = (init = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), authorization: `Bearer ${deviceToken}` },
});

/** Read the event stream until it has produced `wanted` frames, running
 * `while` alongside so there is something to capture. */
async function captureFrames(wanted, during) {
  const controller = new AbortController();
  const res = await fetch(`${SIDECAR}/api/events`, asDevice({ signal: controller.signal }));
  const frames = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const pump = (async () => {
    while (frames.length < wanted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      // events are separated by a blank line; the id: line is not data
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            frames.push(JSON.parse(line.slice(5).trim()));
          } catch {
            /* a comment or a heartbeat */
          }
        }
      }
    }
  })();

  await during();
  await Promise.race([pump, sleep(8000)]);
  controller.abort();
  return frames.slice(0, wanted);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  home = mkdtempSync(join(tmpdir(), "companion-fixtures-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ profile: PROFILE }));

  console.log(`harness on ${HARNESS_PORT}, companion on ${COMPANION_PORT}`);
  const harness = start("harness", [join(ROOT, "server", "index.ts")], {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(HARNESS_PORT),
    // the receiver would otherwise take the port above, which is nothing
    // to do with this but makes the log noisy
    OMB_WEBHOOK_PORT: String(base + 1),
  });
  await waitFor(`${HARNESS}/api/health`, "harness", harness);

  // ── the sidecar, up front, because it is what the phone talks to ───────
  //
  // Every client-facing fixture below is captured *through* here rather than
  // from the harness directly. Capturing from the harness records a response
  // no phone ever receives: the proxy is what strips `resumeCursors`, what
  // rewrites the SSE frames on the way past, and what refuses the routes a
  // device may not have. Fixtures taken upstream of all that test the wrong
  // contract, and would keep passing through exactly the change they exist to
  // catch. Direct harness calls are kept only for setup a phone cannot do.
  const sidecar = start("companion", [join(ROOT, "companion", "src", "index.ts")], {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(HARNESS_PORT),
    OMB_WEBHOOK_PORT: String(base + 1),
    OMB_COMPANION_PORT: String(COMPANION_PORT),
    OMB_CONTROL_PORT: String(CONTROL_PORT),
    OMB_COMPANION_DIR: join(home, "companion"),
  });
  await waitFor(`${CONTROL}/state`, "companion", sidecar);

  // ── what an unpaired phone sees, captured before there is a token ──────
  console.log("writing:");
  write("unauthorized", (await json(`${SIDECAR}/api/bots`)).body);
  write("pair-rejected", (await json(`${SIDECAR}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "000000", deviceName: "Ada's iPhone" }),
  })).body);

  // ── pair, exactly as the phone does ────────────────────────────────────
  const { code } = (await json(`${CONTROL}/pairing`, { method: "POST" })).body;
  const paired = await json(`${SIDECAR}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName: "Ada's iPhone" }),
  });
  if (!paired.body.token) throw new Error(`pairing failed: ${JSON.stringify(paired.body)}`);
  deviceToken = paired.body.token;
  // The token is a live credential for as long as that registry exists.
  // It is thrown away with the temp directory below, but a fixture is a file
  // people copy, so it never gets written in the first place.
  write("pair-response", { ...paired.body, token: "omb_REDACTED" });

  // ── a bot, and a few messages for it to have said ──────────────────────
  const created = await json(`${SIDECAR}/api/bots`, asDevice({ method: "POST" }));
  const bot = created.body.bot;
  if (!bot) throw new Error(`could not create a bot: ${JSON.stringify(created.body)}`);

  console.log("capturing frames");
  const frames = await captureFrames(4, async () => {
    for (let i = 0; i < 3; i++) {
      await fetch(`${SIDECAR}/api/bots/${bot.id}/messages`, asDevice({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `fixture message ${i}` }),
      }));
      await sleep(120);
    }
  });
  if (frames.length === 0) throw new Error("no frames arrived on /api/events");

  write("sse-frames", frames);
  const hello = frames.find((f) => f.kind === "hello");
  if (hello) write("sse-hello", hello);

  // ── a room, so the paged fleet has a group in it ───────────────────────
  //
  // Created directly on the harness: room creation is deliberately not on
  // the sidecar's allowlist, so this is setup the phone cannot perform —
  // like the harness boot itself. Everything after it goes back through the
  // sidecar. Five messages, so a capture capped at three below has a page
  // boundary to show: the decoding test pins messages == 3 and
  // hasMore == true, and this is what makes those numbers deterministic
  // rather than an accident of whichever harness the fixtures were last
  // captured against.
  const madeRoom = await json(`${HARNESS}/api/groups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Fixtures", memberIds: [bot.id] }),
  });
  const room = madeRoom.body.group;
  if (!room) throw new Error(`could not create a room: ${JSON.stringify(madeRoom.body)}`);
  for (let i = 0; i < 5; i++) {
    await fetch(`${SIDECAR}/api/groups/${room.id}/messages`, asDevice({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `room fixture message ${i}` }),
    }));
    await sleep(120);
  }

  // ── the shapes the app hydrates from ───────────────────────────────────
  // messages=3 pairs with the five room messages above; see the room comment.
  write("bots-full", (await json(`${SIDECAR}/api/bots`, asDevice())).body);
  write("bots-paged", (await json(`${SIDECAR}/api/bots?messages=3`, asDevice())).body);
  write(
    "thread-page",
    (await json(`${SIDECAR}/api/threads/${bot.threadId}/messages?limit=2`, asDevice())).body,
  );
  write("config", (await json(`${SIDECAR}/api/config`, asDevice())).body);
  write("instances", (await json(`${SIDECAR}/api/instances`, asDevice())).body);

  // ── and the refusal a paired device still gets ─────────────────────────
  write("forbidden", (await json(`${SIDECAR}/api/config`, asDevice({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xai: { apiKey: "not-a-real-key" } }),
  }))).body);

  console.log("\nnot captured: options-card.json — needs a real approval from a real turn");
}

const cleanup = () => {
  for (const { child } of children) child.kill("SIGKILL");
  if (home) rmSync(home, { recursive: true, force: true });
};

main().then(
  () => (cleanup(), console.log("done")),
  (error) => {
    cleanup();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
