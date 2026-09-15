// End-to-end voice verification against an isolated fixture:
//   1. the wake-word credential + feature flag round-trip, write-only;
//   2. the built-in (zero-key, offline) voice engine — on this machine that
//      is real PowerShell/System.Speech, so the WAV bytes prove the whole
//      route: config gate → spawn → synthesis → response.
// Launches its own fake-engine server; the user's app and data are untouched.
import { launchVerificationServer } from "./control-omb.ts";

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

  console.log(JSON.stringify({ ok: true, platform: process.platform, url: base, dataDir: fixture.info.dataDir, findings }, null, 2));
} finally {
  await fixture.close();
}
