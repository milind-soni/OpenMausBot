import { createServer, type Server } from "node:http";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import type { SttStatus } from "../shared/stt.ts";
import { waitForExit } from "./testing/cleanup.ts";

let fixture: VerificationServer;
let provider: Server;
let baseUrl: string;
let fail = false;
let restarted: ChildProcess | undefined;
let googleFinish = "stop";
let googleMissingText = false;
const googleReceived: Array<{ path: string; authorization?: string; model: string; format?: string; audio: string }> = [];
const received: Array<{ path: string; authorization?: string; model: string; format: string; audio: string }> = [];
const catalogCalls: Array<{ path: string; authorization?: string }> = [];
let catalogFail = false;

beforeAll(async () => {
  provider = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      catalogCalls.push({ path: req.url, authorization: req.headers.authorization });
      const ids = req.url.includes("google") ? ["gemini-audio-one", "gemini-audio-two", "future-google-model"]
        : req.url.includes("groq") ? ["whisper-large-v3", "whisper-large-v3-turbo", "future-groq-model"]
        : ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "future-openai-model"];
      res.writeHead(catalogFail ? 401 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(catalogFail ? { error: { message: "fixture-catalog-secret" } } : { object: "list", data: [...ids, ids[0]].map((id) => ({ id, object: "model" })) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.headers["content-type"]?.startsWith("application/json")) {
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; messages: Array<{ content: string | Array<{ input_audio?: { data: string; format: string } }> }> };
      const audio = input.messages.flatMap((message) => typeof message.content === "string" ? [] : message.content).find((part) => part.input_audio)?.input_audio;
      googleReceived.push({ path: req.url!, authorization: req.headers.authorization, model: input.model, format: audio?.format, audio: Buffer.from(audio?.data ?? "", "base64").toString() });
      res.writeHead(fail ? 403 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(fail ? { error: { message: "fixture-google-input-key" } } : {
        choices: [{ finish_reason: googleFinish, message: { role: "assistant", ...(googleMissingText ? {} : { content: "  hello from Google audio  " }) } }],
      }));
      return;
    }
    const request = new Request("http://fixture/upload", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: Buffer.concat(chunks) });
    const form = await request.formData();
    const file = form.get("file") as File;
    received.push({ path: req.url!, authorization: req.headers.authorization, model: String(form.get("model")), format: String(form.get("response_format")), audio: await file.text() });
    res.writeHead(fail ? 401 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(fail ? { error: { message: "fixture-private-key" } } : { text: "  hello from local speech  " }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
  fixture = await launchVerificationServer();
  console.log(JSON.stringify(fixture.info));
}, hostTimeout(90_000));

afterAll(async () => {
  await waitForExit(restarted, { signal: "SIGTERM" });
  await fixture?.close();
  await new Promise<void>((resolve) => provider ? provider.close(() => resolve()) : resolve());
});

async function settings(stt: unknown, external = false) {
  const res = await fetch(`${fixture.info.url}/api/config${external ? "?secretStorage=external" : ""}`, {
    method: "PUT", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify({ stt }),
  });
  return { status: res.status, body: await res.json() as { stt: SttStatus } };
}

async function transcribe(type = "audio/wav") {
  const res = await fetch(`${fixture.info.url}/api/tts/transcribe`, {
    method: "POST", headers: { "content-type": type, origin: fixture.info.url }, body: "RIFF-fixture-audio",
  });
  return { status: res.status, body: await res.json() };
}

it("saves transcription settings and transcribes through the real server with optional authentication", async () => {
  expect((await transcribe()).status).toBe(409);
  expect((await settings({ provider: "openai", baseUrl: "file:///tmp/audio" })).status).toBe(400);
  const saved = await settings({ provider: "openai", baseUrl, model: "local-whisper", key: "fixture-private-key" });
  expect(saved.status).toBe(200);
  expect(saved.body.stt).toEqual({ provider: "openai", baseUrl, model: "local-whisper", configured: true, keyConfigured: true });
  expect(JSON.stringify(saved.body)).not.toContain("fixture-private-key");
  expect(await transcribe()).toEqual({ status: 200, body: { text: "hello from local speech" } });
  expect(received[0]).toEqual({ path: "/v1/audio/transcriptions", authorization: "Bearer fixture-private-key", model: "local-whisper", format: "json", audio: "RIFF-fixture-audio" });
  expect((await transcribe("application/json")).status).toBe(400);
  expect(received).toHaveLength(1);
  fail = true;
  const rejected = await transcribe();
  expect(rejected.status).toBe(502);
  expect(JSON.stringify(rejected)).not.toContain("fixture-private-key");
  fail = false;
  expect((await settings({ model: "another-transcriber" })).body.stt.keyConfigured).toBe(true);
  expect((await settings({ baseUrl: baseUrl.replace("/v1", "/local/v1") })).body.stt.keyConfigured).toBe(false);
  expect((await transcribe()).status).toBe(200);
  expect(received.at(-1)).toEqual({ path: "/local/v1/audio/transcriptions", authorization: undefined, model: "another-transcriber", format: "json", audio: "RIFF-fixture-audio" });
  const disk = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
  expect(disk.stt).toMatchObject({ provider: "openai", key: "", model: "another-transcriber" });
  expect((await settings({ provider: "auto" })).status).toBe(200);
  expect((await transcribe()).status).toBe(409);
  writeFileSync(`${fixture.info.logPath}.stt.json`, JSON.stringify({ fixture: fixture.info, checks: ["settings saved", "key not echoed", "multipart audio and model", "provider rejection sanitized", "endpoint change clears key", "keyless local transcription", "settings persisted", "automatic fallback restored"], requests: received.map(({ authorization, ...call }) => ({ ...call, authenticated: Boolean(authorization) })) }, null, 2));
}, hostTimeout(60_000));

it("discovers multiple provider models with draft or saved keys without saving or leaking credentials", async () => {
  const configFile = join(fixture.info.dataDir, "config.json");
  const query = async (stt: unknown) => {
    const response = await fetch(`${fixture.info.url}/api/tts/models`, {
      method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify({ stt }),
    });
    return { status: response.status, body: await response.json() as { models?: string[]; error?: string } };
  };
  const before = readFileSync(configFile, "utf8");
  const inferenceCount = received.length + googleReceived.length;
  for (const service of ["openai", "groq", "google"]) {
    const result = await query({ provider: service === "google" ? "gemini" : "openai", baseUrl: `${baseUrl}/catalog/${service}`, key: "fixture-catalog-secret" });
    expect(result.status).toBe(200);
    expect(result.body.models!.length).toBeGreaterThanOrEqual(3);
    expect(new Set(result.body.models).size).toBe(result.body.models!.length);
    expect(result.body.models).toContain(`future-${service}-model`);
    expect(JSON.stringify(result.body)).not.toContain("fixture-catalog-secret");
    expect(catalogCalls.at(-1)).toEqual({ path: `/v1/catalog/${service}/models`, authorization: "Bearer fixture-catalog-secret" });
    expect(readFileSync(configFile, "utf8")).toBe(before);
  }
  expect((await settings({ provider: "openai", baseUrl, model: "saved-audio", key: "fixture-saved-catalog-key" })).status).toBe(200);
  expect((await query({ provider: "openai", baseUrl })).status).toBe(200);
  expect(catalogCalls.at(-1)?.authorization).toBe("Bearer fixture-saved-catalog-key");
  expect((await query({ provider: "openai", baseUrl: `${baseUrl}/changed` })).status).toBe(200);
  expect(catalogCalls.at(-1)?.authorization).toBeUndefined();
  const saved = readFileSync(configFile, "utf8");
  catalogFail = true;
  const failed = await query({ provider: "openai", baseUrl, key: "fixture-catalog-secret" });
  expect(failed.status).toBe(502);
  expect(JSON.stringify(failed.body)).not.toContain("fixture-catalog-secret");
  catalogFail = false;
  expect(readFileSync(configFile, "utf8")).toBe(saved);
  const count = catalogCalls.length;
  expect((await query({ provider: "gemini", baseUrl: `${baseUrl}/google-without-key` })).status).toBe(409);
  expect((await query({ provider: "openai", baseUrl: "file:///tmp" })).status).toBe(400);
  expect(catalogCalls).toHaveLength(count);
  expect(received.length + googleReceived.length).toBe(inferenceCount);
  writeFileSync(`${fixture.info.logPath}.stt-models.json`, JSON.stringify({ fixture: fixture.info, checks: ["OpenAI multiple models", "Groq multiple models", "Google multiple models", "new model IDs retained", "draft keys not saved", "saved key reused only for same endpoint", "keyless local discovery", "errors sanitized", "no inference for discovery"], calls: catalogCalls.map(({ authorization, ...call }) => ({ ...call, authenticated: Boolean(authorization) })) }, null, 2));
}, hostTimeout(60_000));

it("transcribes Google audio through the SDK chat API and refuses incomplete or invalid results", async () => {
  const googleBase = `${baseUrl}/google`;
  expect((await settings({ provider: "gemini", baseUrl: googleBase, model: "gemini-fixture-audio" })).body.stt.configured).toBe(false);
  expect((await transcribe()).status).toBe(409);
  expect(googleReceived).toHaveLength(0);
  expect((await settings({ key: "fixture-google-input-key" }, true)).body.stt.configured).toBe(true);
  expect(await transcribe()).toEqual({ status: 200, body: { text: "hello from Google audio" } });
  expect(googleReceived[0]).toEqual({ path: "/v1/google/chat/completions", authorization: "Bearer fixture-google-input-key", model: "gemini-fixture-audio", format: "wav", audio: "RIFF-fixture-audio" });
  fail = true;
  const rejected = await transcribe();
  expect(rejected.status).toBe(502);
  expect(JSON.stringify(rejected)).not.toContain("fixture-google-input-key");
  expect(googleReceived).toHaveLength(2);
  fail = false;
  googleMissingText = true;
  expect((await transcribe()).status).toBe(502);
  googleMissingText = false;
  googleFinish = "length";
  expect((await transcribe()).status).toBe(502);
  googleFinish = "stop";
  expect((await settings({ provider: "openai", model: "local-whisper" })).body.stt.keyConfigured).toBe(false);
  expect((await transcribe()).status).toBe(200);
  expect(received.at(-1)?.authorization).toBeUndefined();
  expect(received.at(-1)?.path).toBe("/v1/google/audio/transcriptions");
  writeFileSync(`${fixture.info.logPath}.stt-google.json`, JSON.stringify({ fixture: fixture.info, checks: ["Google requires separate key", "SDK audio chat request", "audio and model preserved", "provider errors sanitized without retries", "missing transcript refused", "truncated transcript refused", "provider switch revokes key"], requests: googleReceived.map(({ authorization, ...call }) => ({ ...call, authenticated: Boolean(authorization) })) }, null, 2));
}, hostTimeout(60_000));

it("keeps externally stored keys private and revoked across a real server restart", async () => {
  const saved = await settings({ provider: "openai", baseUrl, model: "local-whisper", key: "fixture-os-store-key" }, true);
  expect(saved.status).toBe(200);
  expect(saved.body.stt.keyConfigured).toBe(true);
  const configFile = join(fixture.info.dataDir, "config.json");
  expect(readFileSync(configFile, "utf8")).not.toContain("fixture-os-store-key");
  expect((await transcribe()).status).toBe(200);
  expect(received.at(-1)?.authorization).toBe("Bearer fixture-os-store-key");
  const changedUrl = `${baseUrl}/other`;
  expect((await settings({ baseUrl: changedUrl })).body.stt.keyConfigured).toBe(false);
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const env = {
    ...verificationServerEnvironment(process.env, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
    OMB_STT_API_KEY: "fixture-os-store-key",
  };
  const log = openSync(fixture.info.logPath, "a", 0o600);
  try { restarted = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", log, log] }); }
  finally { closeSync(log); }
  await expect.poll(async () => {
    try { return (await fetch(`${fixture.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).status; }
    catch { return 0; }
  }, { timeout: hostTimeout(30_000), interval: 100 }).toBe(200);
  const response = await fetch(`${fixture.info.url}/api/config`);
  const status = await response.json() as { stt: SttStatus };
  expect(status.stt).toMatchObject({ baseUrl: changedUrl, keyConfigured: false });
  expect((await transcribe()).status).toBe(200);
  expect(received.at(-1)?.authorization).toBeUndefined();
  expect((await settings({ key: "fresh-key-for-other" }, true)).body.stt.keyConfigured).toBe(true);
  expect((await transcribe()).status).toBe(200);
  expect(received.at(-1)?.authorization).toBe("Bearer fresh-key-for-other");
  expect((await settings({ key: "" }, true)).body.stt.keyConfigured).toBe(false);
  expect(readFileSync(configFile, "utf8")).not.toContain("fresh-key-for-other");
  writeFileSync(`${fixture.info.logPath}.stt-restart.json`, JSON.stringify({ fixture: fixture.info, restartedPid: restarted?.pid, checks: ["external key absent from config", "external key usable before endpoint change", "stale OS credential revoked across restart", "new endpoint key usable", "key removal"], status: status.stt }, null, 2));
}, hostTimeout(60_000));
