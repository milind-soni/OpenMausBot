// End-to-end voice verification against an isolated fixture:
//   1. the wake-word credential + feature flag round-trip, write-only;
//   2. the built-in (zero-key, offline) voice engine — on this machine that
//      is real PowerShell/System.Speech, so the WAV bytes prove the whole
//      route: config gate → spawn → synthesis → response;
//   3. the Piper (offline neural) provider's honest refusal: the fixture
//      home never has the engine provisioned, so selecting it must report
//      `provider: "piper"` and refuse with Piper-specific advice — never
//      ElevenLabs' "add a key";
//   4. the section convention as the voice sees it: `/api/tts/prepare`
//      speaks a reply's lead and never the detail under its headings.
// Launches its own fake-engine server; the user's app and data are untouched.
import { launchVerificationServer } from "./control-astra.ts";

const fixture = await launchVerificationServer();
try {
  const base = fixture.info.url;
  const findings: string[] = [];
  const fail = (message: string): never => {
    throw new Error(message);
  };

  // 1. The wake-word credential saves, is never echoed back, and the
  //    feature flag flips — the exact writes Settings performs.
  const put = async (body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) fail(`PUT /api/config ${JSON.stringify(body)} → ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };

  await put({ wakeWord: { accessKey: "fixture-picovoice-access-key" } });
  const status = await put({ features: { wakeWord: true } });
  const wakeWord = status.wakeWord as { configured?: boolean } | undefined;
  if (wakeWord?.configured !== true) fail(`wakeWord status should report configured, got ${JSON.stringify(wakeWord)}`);
  const echoed = JSON.stringify(status);
  if (echoed.includes("fixture-picovoice-access-key")) fail("the access key was echoed back — write-only violated");
  const envEcho = await fetch(`${base}/api/config`).then((r) => r.json()).then((s) => JSON.stringify(s));
  if (envEcho.includes("fixture-picovoice-access-key")) fail("the access key leaked through a plain GET /api/config");
  findings.push("wake-word credential round-trip: configured=true, write-only respected");

  // 2. The built-in provider needs no key on darwin/win32 and really
  //    synthesizes through the platform engine. Selecting it is the same
  //    config write the Settings toggle performs.
  await put({ tts: { provider: "system", voice: process.platform === "darwin" ? "Albert" : "Microsoft David Desktop" } });
  const providerRes = await fetch(`${base}/api/tts/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Voice verification complete.", voiceId: process.platform === "darwin" ? "Albert" : "Microsoft David Desktop" }),
  });
  if (process.platform === "darwin" || process.platform === "win32") {
    if (!providerRes.ok) fail(`/api/tts/speak on the built-in engine → ${providerRes.status}: ${await providerRes.text()}`);
    const wav = Buffer.from(await providerRes.arrayBuffer());
    if (wav.length < 44 || !wav.subarray(0, 4).toString().includes("RIFF")) {
      fail(`the built-in engine returned ${wav.length} bytes without a WAV header`);
    }
    findings.push(`built-in offline voice: real ${wav.length}-byte WAV from the platform engine`);
  } else {
    if (providerRes.ok) fail("the built-in engine answered on a platform that has none");
    findings.push(`built-in voice correctly refused on ${process.platform}`);
  }

  // 3. Piper is provisioned per machine and absent in the fixture home.
  //    Selecting it must stay honest: status says provider "piper" (not a
  //    silent ElevenLabs fallback) and speak refuses with Piper advice.
  await put({ tts: { provider: "piper", voice: "en_US-amy-medium" } });
  // a status read, not a write: PUT requires a patch, GET is the read path
  const piperStatus = (await fetch(`${base}/api/config`).then((r) => r.json())) as Record<string, unknown>;
  const piperTts = piperStatus.tts as { provider?: string; piperAvailable?: boolean } | undefined;
  if (piperTts?.provider !== "piper") {
    fail(`selected piper but status reports provider ${JSON.stringify(piperTts)}`);
  }
  if (piperTts.piperAvailable !== false) {
    fail(`fixture home should have no Piper engine, status says ${JSON.stringify(piperTts)}`);
  }
  const piperSpeak = await fetch(`${base}/api/tts/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Should not synthesize.", voiceId: "en_US-amy-medium" }),
  });
  if (piperSpeak.ok) fail("Piper answered without an engine installed");
  const piperError = ((await piperSpeak.json()) as { error?: string }).error ?? "";
  if (!/piper/i.test(piperError) || /elevenlabs/i.test(piperError)) {
    fail(`Piper refusal should name Piper, not ElevenLabs — got: ${piperError}`);
  }
  findings.push(`piper without an engine: provider stays "piper", refusal names Piper (${piperSpeak.status})`);
  // restore so the run leaves no piper selection behind in the (disposable)
  // fixture config — mirrors what Settings does when the user switches back.
  await put({ tts: { provider: "system", voice: process.platform === "darwin" ? "Albert" : "Microsoft David Desktop" } });

  // 4. /api/tts/prepare speaks the lead of a reply, not the detail under it.
  //    This is the route the renderer calls before every spoken reply and
  //    every call turn, so it is where the section convention becomes
  //    audible: a diff read aloud is the failure the split exists to stop.
  const prepare = async (text: string): Promise<string> => {
    const res = await fetch(`${base}/api/tts/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) fail(`POST /api/tts/prepare → ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { utterances?: string[] }).utterances?.join(" ") ?? "";
  };
  const spoken = await prepare(
    "The redirect is fixed and the suite passes.\n\n## What changed\n\nI moved the query string onto the new path.\n\n## Files\n\n- server/auth.ts",
  );
  if (!spoken.includes("The redirect is fixed and the suite passes.")) {
    fail(`the lead was not spoken: ${JSON.stringify(spoken)}`);
  }
  if (spoken.includes("query string") || spoken.toLowerCase().includes("auth.ts")) {
    fail(`the detail under the headings was read aloud: ${JSON.stringify(spoken)}`);
  }
  findings.push("tts prepare: a headed reply speaks its lead only, no detail read aloud");

  const unstructured = await prepare("Tests pass.\n\n- one\n- two\n\nMore prose.");
  if (unstructured !== "Tests pass.") {
    fail(`an unheaded reply should speak its first paragraph, got ${JSON.stringify(unstructured)}`);
  }
  findings.push("tts prepare: an unheaded reply falls back to its first paragraph");

  // 5. A model wrote its computer action as reply text — the failure a real
  //    transcript caught. The payload and its narration are the tool
  //    channel's business: a pure-leak reply is silent, and a leak around
  //    prose speaks only the prose.
  const leaked = await prepare('We need to output tool use calls.\n{ "action": "press", "keys": ["win", "r"] }');
  if (leaked !== "") {
    fail(`a reply that is only a leaked tool payload should be silent, got ${JSON.stringify(leaked)}`);
  }
  const around = await prepare('Opening the Run dialog.\n{ "action": "press", "keys": ["win", "r"] }');
  if (around !== "Opening the Run dialog.") {
    fail(`prose around a leaked payload should survive alone, got ${JSON.stringify(around)}`);
  }
  findings.push("tts prepare: leaked tool-call JSON is never spoken; surrounding prose survives");

  //    The check above is shaped exactly like the bug it cannot see: every case
  //    it feeds the route is newline-separated, while the defect was a payload
  //    sitting inside a sentence. There the removal edited the sentence around
  //    it — "The policy uses by default." — and that is what a voice said. So
  //    the inline case is checked on the same route, and the whole sentence,
  //    payload included, must come back unedited rather than merely silent.
  const inlineCases = [
    'The policy uses {"action": "click", "x": 1} by default.',
    'I set {"action":"type","text":"hello"} in the script.',
  ];
  for (const inlineCase of inlineCases) {
    const spokenInline = await prepare(inlineCase);
    if (spokenInline !== inlineCase) {
      fail(`an inline payload must leave its sentence intact, got ${JSON.stringify(spokenInline)}`);
    }
  }
  findings.push("tts prepare: an inline payload leaves its sentence intact instead of editing it");

  //    The mirror of that: a sentence that only sounds like tool narration is
  //    prose. A broader pattern used to delete these, and alone in a reply it
  //    left the voice with nothing at all to say.
  const ordinary = [
    "We need to send the report to the team before Friday.",
    "I need to call the vendor about the invoice.",
    "Then let us call it a day.",
  ];
  for (const sentence of ordinary) {
    const spokenSentence = await prepare(sentence);
    if (spokenSentence !== sentence) {
      fail(`an ordinary sentence must be spoken intact, got ${JSON.stringify(spokenSentence)}`);
    }
  }
  findings.push("tts prepare: an ordinary sentence that only sounds like narration is spoken intact");

  console.log(JSON.stringify({ ok: true, platform: process.platform, url: base, dataDir: fixture.info.dataDir, findings }, null, 2));
} finally {
  await fixture.close();
}
