// Voice-latency measurement harness. Drives the real app — renderer store
// speak path, the Speaker, the server TTS route and the provider call —
// against the committed corpus fixture, through the same disposable
// verification fixture `control-omb ui` uses. The record protocol is the
// deterministic stub: no live engine call, no engine key. See
// fixtures/voice-latency/README.md for the protocol.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runControlOmb, launchVerificationServer, type VerificationServer } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";
import { mountPreview, type MountedPreview } from "./preview-fixture.ts";
import { CADENCE, corpusFixtureId, readLfText, SYNTHESIS } from "./voice-latency-corpus.ts";
import { launchVoiceLatencyStub, STUB_KEY, STUB_MODEL, STUB_VOICE } from "./voice-latency-stub.ts";
import {
  summarizeVoiceTurn,
  summarizeVoiceRun,
  type VoiceProbeSample,
} from "../../shared/voice-latency-probe.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures", "voice-latency");
const CORPUS_PATH = join(FIXTURE_DIR, "corpus.json");
const MANIFEST_PATH = join(FIXTURE_DIR, "manifest.json");
const LOGS_DIR = join(FIXTURE_DIR, "logs");
const BASE_COMMIT = execFileSync("git", ["rev-parse", "--short=9", "HEAD"], { cwd: join(HERE, "..", "..") }).toString().trim();

const WARMUP_REPLY = "Warm. One throwaway reply to prime the voice path.";

interface CorpusReply {
  id: string;
  shape: string;
  text: string;
}

interface ManifestReply {
  id: string;
  blocks: number;
}

interface Manifest {
  corpusFixtureId: string;
  replies: ManifestReply[];
}

interface ReplyRow {
  replyId: string;
  shape: string;
  blocksExpected: number;
  blocksMeasured: number | null;
  t0ToFirstAudioMs: number | null;
  t0ToMessageFrameMs: number | null;
  messageFrameToFirstAudioMs: number | null;
  gapCount: number;
  totalGapMs: number;
  longestGapMs: number;
  measured: boolean;
  modeled: boolean;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readCorpus(raw: unknown): CorpusReply[] {
  if (!raw || typeof raw !== "object" || !("replies" in raw) || !Array.isArray((raw as { replies: unknown }).replies)) {
    throw new Error("corpus fixture has no replies array");
  }
  return (raw as { replies: unknown[] }).replies.map((reply): CorpusReply => {
    if (!reply || typeof reply !== "object") throw new Error("corpus reply is not an object");
    const held = reply as Record<string, unknown>;
    if (typeof held.id !== "string" || typeof held.shape !== "string" || typeof held.text !== "string") {
      throw new Error("corpus reply missing id/shape/text");
    }
    return { id: held.id, shape: held.shape, text: held.text };
  });
}

function readManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== "object") throw new Error("manifest is not an object");
  const held = raw as Record<string, unknown>;
  if (typeof held.corpusFixtureId !== "string" || !Array.isArray(held.replies)) throw new Error("manifest missing corpusFixtureId/replies");
  const replies = held.replies.map((reply): ManifestReply => {
    if (!reply || typeof reply !== "object") throw new Error("manifest reply is not an object");
    const row = reply as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.blocks !== "number") throw new Error("manifest reply missing id/blocks");
    return { id: row.id, blocks: row.blocks };
  });
  return { corpusFixtureId: held.corpusFixtureId, replies };
}

function usage(): never {
  console.error("usage: node --experimental-strip-types scripts/testing/voice-latency-harness.ts [--limit N] [--label before|after]");
  process.exit(2);
}

function parseArgs(argv: string[]): { limit: number | null; label: string } {
  let limit: number | null = null;
  let label = "before";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--limit") {
      limit = Number(argv[i + 1]);
      if (!Number.isSafeInteger(limit) || limit < 1) usage();
      i += 1;
    } else if (argv[i] === "--label") {
      label = String(argv[i + 1] ?? "");
      if (label !== "before" && label !== "after") usage();
      i += 1;
    } else {
      usage();
    }
  }
  return { limit, label };
}

async function evalInPage(binary: string, env: NodeJS.ProcessEnv, js: string): Promise<unknown> {
  const data = await agentBrowser(binary, env, ["eval", js]);
  if ("result" in data) return data.result;
  if ("value" in data) return data.value;
  return data;
}

const sampleComplete = (sample: VoiceProbeSample): boolean =>
  typeof sample.blockCount === "number"
  && sample.blocks.length === sample.blockCount
  && sample.blocks.every((block) => typeof block.endAt === "number");

async function main(): Promise<void> {
  const { limit, label } = parseArgs(process.argv.slice(2));
  const corpusText = readLfText(CORPUS_PATH);
  const corpusSha = corpusFixtureId(corpusText);
  const manifest = readManifest(readJson(MANIFEST_PATH));
  if (manifest.corpusFixtureId !== corpusSha) {
    throw new Error(`corpus fixture drift: manifest ${manifest.corpusFixtureId} != file ${corpusSha}`);
  }
  const corpus = readCorpus(JSON.parse(corpusText));
  const selected = limit ? corpus.slice(0, limit) : corpus;

  const { binary, chrome } = await ensureUiBrowser(process.env, (line) => console.error(line));

  // The record protocol's synthesis endpoint: loopback, keyless, modeled
  // timing at the manifest's pinned RTF. Launched before the fixture so the
  // provider override can point at it.
  const stub = await launchVoiceLatencyStub();

  // Marker routing, not ordered slots: the driver replays a user message over
  // several CLI launches, and slot order would misalign replies across them.
  const WARMUP_MARKER = "omb voice probe warmup";
  const markerPath = join(mkdtempSync(join(tmpdir(), "omb-voice-latency-")), "marker-replies.json");
  const markerReplies: Record<string, string> = { [WARMUP_MARKER]: WARMUP_REPLY };
  for (const reply of selected) markerReplies[`omb voice probe ${reply.id}`] = reply.text;
  writeFileSync(markerPath, JSON.stringify(markerReplies));
  const fakeEnv: NodeJS.ProcessEnv = {
    FAKE_CLAUDE_MARKER_REPLIES: markerPath,
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_STREAM_CADENCE: `${CADENCE.chunkChars}:${CADENCE.intervalMs}`,
    OMB_ELEVENLABS_API: stub.url,
  };

  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let browserEnv: NodeJS.ProcessEnv | undefined;
  const rows: ReplyRow[] = [];
  try {
    const stop = new AbortController();
    process.once("SIGINT", () => stop.abort());
    process.once("SIGTERM", () => stop.abort());
    // The signal feeds launchVerificationServer only; polling it here is what
    // unwinds an interrupt to the finally teardown.
    const throwIfAborted = (): void => stop.signal.throwIfAborted();
    const serverEnv: NodeJS.ProcessEnv = { ...process.env, ...fakeEnv };
    // Keyless record run: an exported live key would otherwise ride the
    // parent env into measurement, even though nothing reads it here.
    delete serverEnv.OMB_TTS_KEY;
    fixture = await launchVerificationServer(serverEnv, stop.signal, undefined,
      { binaryPath: binary, executablePath: chrome ?? "" });

    const api = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
      const res = await fetch(`${fixture!.info.url}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(parsed)}`);
      return parsed as Record<string, unknown>;
    };

    await api("PATCH", "/api/config", { tts: { provider: "elevenlabs", key: STUB_KEY, model: STUB_MODEL, voice: STUB_VOICE } });
    const created = await runControlOmb(["new-bot", "--name", "VoiceProbe", "--url", fixture.info.url]) as { bot: { id: string } };
    const botId = created.bot.id;
    await api("PATCH", `/api/bots/${botId}`, { speakReplies: true, voice: STUB_VOICE });
    console.error(`tts provider=elevenlabs(stub) model=${STUB_MODEL} voice=${STUB_VOICE} synthesis=modeled rtf=${SYNTHESIS.rtf} audioMsPerChar=${SYNTHESIS.audioMsPerChar}`);

    preview = await mountPreview(fixture, {
      entry: "/scripts/testing/threads-preview.tsx",
      route: "/__threads.html",
      title: "Isolated OpenMaus Chat",
      logLevel: "warn",
    });
    const session = { home: fixture.info.dataDir, session: `omb-voice-${new URL(fixture.info.url).port}`, chrome };
    browserEnv = sessionEnv(session, process.env);
    // Headless Chrome otherwise refuses media playback without a user gesture.
    browserEnv.AGENT_BROWSER_ARGS = [browserEnv.AGENT_BROWSER_ARGS ?? "", "--autoplay-policy=no-user-gesture-required"].filter(Boolean).join("\n");
    await agentBrowser(binary, browserEnv, ["open", `${preview.previewUrl}?ombVoiceProbe=1`], 120_000);

    // The `open` verb drops the query string, so the sink is installed by
    // eval; the preview entry's ?ombVoiceProbe hook stays as documentation.
    await evalInPage(binary, browserEnv, "window.__ombVoiceProbe = window.__ombVoiceProbe ?? []");
    if (await evalInPage(binary, browserEnv, "Array.isArray(window.__ombVoiceProbe)") !== true) {
      throw new Error("voice probe sink failed to install in the page");
    }
    // The app must render (and hydrate its event stream) before the first
    // turn, or the warmup's frames never reach the page's recorder.
    for (let i = 0; i < 60; i += 1) {
      throwIfAborted();
      const booted = await evalInPage(binary, browserEnv, "(document.getElementById('root')?.children.length ?? 0) > 0");
      if (booted === true) break;
      if (i === 59) throw new Error("app never rendered: page stayed empty for 30s");
      await sleep(500);
    }
    const seen = new Set<string>();

    const pullSamples = async (): Promise<VoiceProbeSample[]> => {
      const raw = await evalInPage(binary, browserEnv!, "JSON.stringify(window.__ombVoiceProbe)");
      if (typeof raw !== "string") return [];
      return JSON.parse(raw) as VoiceProbeSample[];
    };

    // A streaming turn emits one message frame per delta chunk, each speaking;
    // a turn is settled when no new frame has appeared for a quiet window and
    // the final frame finished playing.
    const QUIET_POLLS = 4;
    // Settle only after the turn's OWN reply fully streamed: replays of the
    // previous marker can still land early in this window and would otherwise
    // settle the turn before its first frame exists.
    const settleTurn = async (scope: string, timeoutMs: number, expectedChars: number): Promise<VoiceProbeSample[] | null> => {
      const deadline = Date.now() + timeoutMs;
      let quiet = 0;
      let lastCount = -1;
      for (;;) {
        throwIfAborted();
        const samples = await pullSamples();
        const fresh = samples.filter((sample) => !seen.has(sample.messageId));
        if (samples.length !== lastCount) {
          lastCount = samples.length;
          quiet = 0;
        } else {
          quiet += 1;
        }
        const own = fresh.filter((frame) => (frame.textChars ?? -1) === expectedChars && sampleComplete(frame));
        const settled = quiet >= QUIET_POLLS && own.length > 0;
        if (settled) {
          console.error(`${scope}: settled frames ${fresh.map((frame) => `${frame.textChars ?? "?"}c${sampleComplete(frame) ? "" : "~"}`).join(" ")}`);
          for (const sample of fresh) seen.add(sample.messageId);
          return fresh;
        }
        if (Date.now() > deadline) {
          const href = await evalInPage(binary, browserEnv!, "location.href").catch(() => "?");
          console.error(`${scope} timeout: samples=${samples.length} fresh=${fresh.length} quiet=${quiet} own=${own.length} expected=${expectedChars}c href=${JSON.stringify(href)}`);
          try {
            const tail = readFileSync(fixture!.info.logPath, "utf8").split("\n").filter((line) =>
              line.includes("[omb-turn]") || line.includes("[omb-error]") || line.includes("tts")).slice(-10);
            for (const line of tail) console.error(`  srv ${line.slice(0, 240)}`);
          } catch {}
          return null;
        }
        await sleep(500);
      }
    };

    // Frames going quiet does not mean the server finished: the driver
    // legitimately replays a user message over several CLI launches, and the
    // next POST's turn would queue behind that chain. Gate on the task's own
    // busy flag before handing the turn slot to the next reply.
    const waitServerIdle = async (timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      let idleStreak = 0;
      for (;;) {
        throwIfAborted();
        const raw = await api("GET", "/api/bots");
        const bots = Array.isArray(raw.bots) ? raw.bots as Array<{ id?: string; tasks?: Array<{ busy?: boolean }> }> : [];
        const mine = bots.find((bot) => bot.id === botId);
        const busyCount = (mine?.tasks ?? []).filter((entry) => entry.busy === true).length;
        idleStreak = mine && busyCount === 0 ? idleStreak + 1 : 0;
        if (idleStreak >= 2) return;
        if (Date.now() > deadline) {
          console.error(`idle debug: bots=${bots.length} mine=${mine?.id ?? "none"} busyTasks=${busyCount}`);
          throw new Error(`server turn never went idle`);
        }
        await sleep(500);
      }
    };

    const driveTurn = async (scope: string, prompt: string, promptChars: number, timeoutMs: number): Promise<VoiceProbeSample[] | null> => {
      await api("POST", `/api/bots/${botId}/messages`, { text: prompt });
      const frames = await settleTurn(scope, timeoutMs, promptChars);
      await waitServerIdle(120_000);
      return frames;
    };

    // Warmup: one spoken reply through the whole path, discarded.
    const warmup = await driveTurn("warmup", WARMUP_MARKER, WARMUP_REPLY.length, 60_000);
    if (!warmup) throw new Error("warmup reply never finished; aborting before the corpus");
    console.error("warmup complete=true");

    for (const reply of selected) {
      throwIfAborted();
      const expected = manifest.replies.find((row) => row.id === reply.id)?.blocks;
      if (!expected) throw new Error(`manifest has no block count for ${reply.id}`);
      const timeout = 45_000 + expected * 8_000;
      const frames = await driveTurn(`reply ${reply.id}`, `omb voice probe ${reply.id}`, reply.text.length, timeout);
      // The turn's other frames carry chunk-sized prefixes or trailing
      // auxiliary messages; the corpus reply is identified by its length.
      const audioFrame = frames?.filter((frame) => frame.textChars === reply.text.length)
        .find((frame) => sampleComplete(frame));
      const summary = frames && audioFrame ? summarizeVoiceTurn(frames, audioFrame) : null;
      if (frames && !audioFrame) console.error(`reply ${reply.id}: frames ${frames.map((frame) => `${frame.textChars ?? "?"}c/${frame.blocks.length}b${sampleComplete(frame) ? "" : "~"}`).join(" ")}`);
      rows.push({
        replyId: reply.id,
        shape: reply.shape,
        blocksExpected: expected,
        blocksMeasured: summary?.blocksMeasured ?? null,
        t0ToFirstAudioMs: summary?.t0ToFirstAudioMs ?? null,
        t0ToMessageFrameMs: summary?.t0ToMessageFrameMs ?? null,
        messageFrameToFirstAudioMs: summary?.messageFrameToFirstAudioMs ?? null,
        gapCount: summary?.gapCount ?? 0,
        totalGapMs: summary?.totalGapMs ?? 0,
        longestGapMs: summary?.longestGapMs ?? 0,
        measured: summary !== null,
        modeled: true,
      });
      console.error(`${reply.id} blocks=${summary?.blocksMeasured ?? "?"}/${expected} first=${summary?.t0ToFirstAudioMs ?? "?"}ms gaps=${summary?.gapCount ?? "?"} longest=${summary?.longestGapMs ?? "?"}ms frames=${frames?.length ?? 0}`);
    }

    const totals = summarizeVoiceRun(rows.filter((row) => row.measured).map((row) => ({
      t0ToFirstAudioMs: row.t0ToFirstAudioMs,
      gapCount: row.gapCount,
      totalGapMs: row.totalGapMs,
      longestGapMs: row.longestGapMs,
    })));
    const userAgent = await evalInPage(binary, browserEnv, "navigator.userAgent").catch(() => null);
    const log = {
      kind: "voice-latency-run",
      label,
      corpusFixtureId: corpusSha,
      baseCommit: BASE_COMMIT,
      measuredBuildCommit: process.env.OMB_MEASURED_COMMIT ?? "(unset: worktree HEAD)",
      date: new Date().toISOString(),
      machine: { platform: process.platform, arch: process.arch, cpuModel: cpus()[0]?.model ?? null },
      configSummary: { provider: "elevenlabs (record stub)", model: STUB_MODEL, voice: STUB_VOICE },
      synthesis: {
        protocol: "elevenlabs-wire stub on loopback; no live engine call, no engine key",
        modeled: true,
        rtf: SYNTHESIS.rtf,
        audioMsPerChar: SYNTHESIS.audioMsPerChar,
        synthesisMsPerChar: SYNTHESIS.rtf * SYNTHESIS.audioMsPerChar,
      },
      cadence: CADENCE,
      limit: limit ?? null,
      userAgent,
      totals: { ...totals, modeled: true },
      replies: rows,
    };
    mkdirSync(LOGS_DIR, { recursive: true });
    const logPath = join(LOGS_DIR, `${label}-${corpusSha.slice(0, 12)}.json`);
    const body = `${JSON.stringify(log, null, 2)}\n`;
    writeFileSync(logPath, body);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      logPath,
      logFixtureId: sha256(body),
      corpusFixtureId: corpusSha,
      synthesis: log.synthesis,
      totals: log.totals,
    }, null, 2)}\n`);
  } finally {
    if (browserEnv) await agentBrowser(binary, browserEnv, ["close"], 15_000).catch(() => {});
    await preview?.close();
    await fixture?.close();
    await stub.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
