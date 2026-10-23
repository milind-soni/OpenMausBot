// The TTS provider is a loopback Chatterbox stub, so no external service is reached.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { listSystemVoices } from "./tts/system-voices.ts";

const MP3 = Buffer.from("ID3 fake mp3 for the voice note fixture");

async function withVoiceFixture(test: (f: any) => Promise<void>, options?: { failFirstAudioAppend?: boolean }) {
  const session = await launchVerificationServer(
    {
      ...process.env,
      ...(options?.failFirstAudioAppend ? { OMB_TEST_FAIL_AUDIO_APPEND_ONCE: "1" } : {}),
    },
    undefined,
    undefined,
    undefined,
    undefined,
    { scripted: true },
  );
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  let ttsServer: Server | undefined;
  const seen: Array<{ input: string; voice: string }> = [];
  const dataDir = session.info.dataDir;
  const planPath = join(dataDir, "room-plan.json");
  try {
    await test({
      session,
      cli,
      api,
      seen,
      dataDir,
      attachmentsDir: () => join(dataDir, "attachments"),
      mp3Files: () => {
        const dir = join(dataDir, "attachments");
        return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".mp3")) : [];
      },
      savePlan: (plan: Record<string, unknown>) => writeFileSync(planPath, JSON.stringify(plan)),
      evidence: () => existsSync(planPath + ".evidence.jsonl")
        ? readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
      messages: async (threadId: string) => (await api("/api/threads/" + threadId + "/messages")).messages,
      serveTts: async (options?: { holdUntil?: string; audio?: { mime: string; bytes: Buffer } }) => {
        const server = createServer((req, res) => {
          let raw = "";
          req.on("data", (chunk: Buffer) => { raw += chunk; });
          req.on("end", () => {
            if (!(req.url ?? "").includes("/audio/speech")) {
              res.writeHead(404);
              res.end();
              return;
            }
            const body = JSON.parse(raw);
            seen.push({ input: String(body.input ?? ""), voice: String(body.voice ?? "") });
            const { mime, bytes } = options?.audio ?? { mime: "audio/mpeg", bytes: MP3 };
            const finish = () => {
              res.writeHead(200, { "content-type": mime, "content-length": String(bytes.byteLength) });
              res.end(bytes);
            };
            const holdUntil = options?.holdUntil;
            if (!holdUntil) return finish();
            const tick = () => {
              if (existsSync(holdUntil)) finish();
              else setTimeout(tick, 25);
            };
            tick();
          });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        ttsServer = server;
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no stub port");
        return "http://127.0.0.1:" + address.port;
      },
    });
  } finally {
    ttsServer?.close();
    await session.close();
  }
}

it("advertises send_voice_note to a ready bot and attaches the clip to the settling reply", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Voice note bot")).bot;
  const note = "Quick voice note: the export finished and every check passed.";
  f.savePlan({
    [bot.id]: {
      steps: [{ tool: "send_voice_note", arguments: { text: "  " + note + "  " } }],
      reply: "The summary you can also listen to.",
    },
  });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Send the status as a voice note.");
  expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");

  const turn = f.evidence().find((entry: any) => entry.botId === bot.id);
  expect(turn).toBeTruthy();
  const listed = turn.evidence[0].result.tools.map((tool: any) => tool.name);
  expect(listed).toContain("send_voice_note");
  const step = turn.evidence.find((entry: any) => entry.step);
  expect(step.response.result.isError).toBeFalsy();
  expect(step.response.result.content[0].text).toContain("Voice note recorded");

  expect(f.seen).toEqual([{ input: note, voice: "voice-a" }]);

  const messages = await f.messages(bot.activeTaskId);
  const withAudio = messages.filter((m: any) => (m.attachments ?? []).some((a: any) => a.kind === "audio"));
  expect(withAudio).toHaveLength(1);
  expect(withAudio[0].role).toBe("bot");
  // The words move onto the attachment: the reply never reads twice.
  expect(withAudio[0].text).toBe("The summary you can also listen to.");
  const audio = withAudio[0].attachments.find((a: any) => a.kind === "audio");
  expect(audio.mime).toBe("audio/mpeg");
  expect(audio.text).toBe(note);

  const files = f.mp3Files();
  expect(files).toHaveLength(1);
  expect(audio.path.endsWith(files[0])).toBe(true);
  const stored = join(f.attachmentsDir(), files[0]);
  // Windows cannot represent a POSIX owner-only mode.
  if (process.platform !== "win32") expect(statSync(stored).mode & 0o777).toBe(0o600);
  expect(readFileSync(stored).equals(MP3)).toBe(true);
}), 60_000);

async function sendWavNote(f: any): Promise<Buffer> {
  const bot = (await f.cli("new-bot", "--name", "WAV voice bot")).bot;
  f.savePlan({ [bot.id]: { steps: [{ tool: "send_voice_note", arguments: { text: "A WAV note." } }], reply: "Sent." } });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Send a voice note.");
  const waited = await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30");
  const step = f.evidence().find((entry: any) => entry.botId === bot.id).evidence.find((entry: any) => entry.step);
  expect(step.response.result.content[0].text).toContain("Voice note recorded");
  expect(waited.status).toBe("settled");

  const messages = await f.messages(bot.activeTaskId);
  const audio = messages.flatMap((m: any) => m.attachments ?? []).find((a: any) => a.kind === "audio");
  expect(audio?.mime).toBe("audio/wav");
  const name = audio.path.split(/[\\/]/).pop();
  expect(name).toMatch(/^[\w-]+\.wav$/);
  const res = await fetch(f.session.info.url + "/api/attachments/" + name);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/wav");
  return Buffer.from(await res.arrayBuffer());
}

it("delivers a WAV voice note from a provider that answers in WAV", async () => withVoiceFixture(async (f) => {
  const wav = Buffer.from("RIFF\0\0\0\0WAVE fake wav for the voice note fixture", "latin1");
  const baseUrl = await f.serveTts({ audio: { mime: "audio/wav", bytes: wav } });
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  expect((await sendWavNote(f)).equals(wav)).toBe(true);
}), 60_000);

it.runIf(process.platform === "darwin")("delivers a voice note spoken by the built-in Mac voices", async () => withVoiceFixture(async (f) => {
  const [voice] = await listSystemVoices();
  await f.api("/api/config", { tts: { provider: "system", voice: voice!.id } }, "PUT");
  const served = await sendWavNote(f);
  expect(served.subarray(0, 4).toString("latin1")).toBe("RIFF");
  expect(served.subarray(8, 12).toString("latin1")).toBe("WAVE");
}), 60_000);

it("keeps a voice-only reply's words on the attachment as its transcript when the turn writes no reply", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Voice only bot")).bot;
  const note = "Voice only: nothing else to read here.";
  f.savePlan({ [bot.id]: { steps: [{ tool: "send_voice_note", arguments: { text: note } }], reply: "" } });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Answer with the voice note alone.");
  expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");

  const messages = await f.messages(bot.activeTaskId);
  const withAudio = messages.filter((m: any) => (m.attachments ?? []).some((a: any) => a.kind === "audio"));
  expect(withAudio).toHaveLength(1);
  expect(withAudio[0].text).toBe("");
  expect(withAudio[0].attachments.find((a: any) => a.kind === "audio").text).toBe(note);
  expect(f.mp3Files()).toHaveLength(1);
}), 60_000);

it("hides the tool and refuses the call when no voice is configured", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Silent bot")).bot;
  f.savePlan({
    [bot.id]: {
      steps: [{ tool: "send_voice_note", arguments: { text: "Should not synthesize." }, expectError: true }],
      reply: "Done without a note.",
    },
  });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Try a voice note.");
  expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");

  const turn = f.evidence().find((entry: any) => entry.botId === bot.id);
  const listed = turn.evidence[0].result.tools.map((tool: any) => tool.name);
  expect(listed).not.toContain("send_voice_note");
  const step = turn.evidence.find((entry: any) => entry.step);
  expect(Boolean(step.response.error || step.response.result?.isError)).toBe(true);
  const messages = await f.messages(bot.activeTaskId);
  expect(messages.some((m: any) => m.text === "Done without a note.")).toBe(true);
  expect(messages.some((m: any) => (m.attachments ?? []).some((a: any) => a.kind === "audio"))).toBe(false);
  expect(f.seen).toEqual([]);
  expect(f.mp3Files()).toEqual([]);
}), 60_000);

it("hides the tool and refuses the call when voice notes are turned off for the bot", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Muted note bot")).bot;
  const patched = await f.api("/api/bots/" + bot.id, { voiceNotes: false }, "PATCH");
  expect(patched.bot.voiceNotes).toBe(false);
  f.savePlan({
    [bot.id]: {
      steps: [{ tool: "send_voice_note", arguments: { text: "Should not synthesize." }, expectError: true }],
      reply: "Done without a note.",
    },
  });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Try a voice note.");
  expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");

  const turn = f.evidence().find((entry: any) => entry.botId === bot.id);
  const listed = turn.evidence[0].result.tools.map((tool: any) => tool.name);
  expect(listed).not.toContain("send_voice_note");
  const step = turn.evidence.find((entry: any) => entry.step);
  expect(Boolean(step.response.error || step.response.result?.isError)).toBe(true);
  const messages = await f.messages(bot.activeTaskId);
  expect(messages.some((m: any) => (m.attachments ?? []).some((a: any) => a.kind === "audio"))).toBe(false);
  expect(f.seen).toEqual([]);
  expect(f.mp3Files()).toEqual([]);
}), 60_000);

it("attaches a parked voice note to a room post and delivers it exactly once", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Room note bot")).bot;
  const room = (await f.cli("new-channel", "--name", "Announcements", "--members", bot.id)).channel;
  const note = "Team update: the deploy is green and every check passed.";
  f.savePlan({
    [bot.id]: {
      steps: [
        { tool: "send_voice_note", arguments: { text: note } },
        { tool: "post_to_room", arguments: { group_id: room.id, message: "Deploy status: green.", attach_voice_note: true } },
      ],
      reply: "Posted the update to the room with the note attached.",
    },
  });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Tell the room how the deploy went.");
  expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");

  const post = f.evidence().find((entry: any) => entry.botId === bot.id).evidence.find((entry: any) => entry.step?.tool === "post_to_room");
  expect(post.response.result.isError).toBeFalsy();
  expect(post.response.result.content[0].text).toContain("with the voice note attached");

  const roomMessages = await f.messages(room.activeTaskId);
  const posted = roomMessages.find((m: any) => m.text === "Deploy status: green.");
  expect(posted).toBeTruthy();
  const audio = (posted.attachments ?? []).find((a: any) => a.kind === "audio");
  expect(audio?.mime).toBe("audio/mpeg");
  expect(audio.text).toBe(note);

  const own = await f.messages(bot.activeTaskId);
  expect(own.some((m: any) => (m.attachments ?? []).some((a: any) => a.kind === "audio"))).toBe(false);
  expect(f.mp3Files()).toHaveLength(1);
  expect(audio.path.endsWith(f.mp3Files()[0])).toBe(true);
}), 60_000);

it("refuses a room post that asks to attach a voice note this turn never recorded", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Empty note bot")).bot;
  const room = (await f.cli("new-channel", "--name", "Empty notes", "--members", bot.id)).channel;
  f.savePlan({
    [bot.id]: {
      steps: [
        { tool: "post_to_room", arguments: { group_id: room.id, message: "Nothing to hear here.", attach_voice_note: true }, expectError: true },
      ],
      reply: "The post was refused.",
    },
  });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Post an update with a note you never recorded.");
  expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");

  const post = f.evidence().find((entry: any) => entry.botId === bot.id).evidence.find((entry: any) => entry.step?.tool === "post_to_room");
  expect(post.response.result.isError).toBe(true);
  expect(post.response.result.content[0].text).toContain("call send_voice_note");
  const roomMessages = await f.messages(room.activeTaskId);
  expect(roomMessages.some((m: any) => m.text === "Nothing to hear here.")).toBe(false);
  expect(f.mp3Files()).toEqual([]);
}), 60_000);

it("keeps the parked note when the room-post append fails, so a retry can attach it", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Retried note bot")).bot;
  const room = (await f.cli("new-channel", "--name", "Deploy notes", "--members", bot.id)).channel;
  const note = "Team update: one retry later, the deploy is green.";
  f.savePlan({
    [bot.id]: {
      steps: [
        { tool: "send_voice_note", arguments: { text: note } },
        { tool: "post_to_room", arguments: { group_id: room.id, message: "Deploy status: green.", attach_voice_note: true }, expectError: true },
        { tool: "post_to_room", arguments: { group_id: room.id, message: "Deploy status: green, retried.", attach_voice_note: true } },
      ],
      reply: "Posted the update after one persistence hiccup.",
    },
  });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Tell the room how the deploy went.");
  expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");

  const posts = f.evidence().find((entry: any) => entry.botId === bot.id).evidence
    .filter((entry: any) => entry.step?.tool === "post_to_room");
  expect(posts).toHaveLength(2);
  const failed = posts[0].response;
  expect(Boolean(failed.error || failed.result?.isError)).toBe(true);
  expect(String(failed.result?.content?.[0]?.text ?? failed.error ?? "")).not.toContain("no voice note to attach");
  const retried = posts[1].response;
  expect(Boolean(retried.error || retried.result?.isError)).toBe(false);
  expect(retried.result.content[0].text).toContain("with the voice note attached");

  // Different text, so the room's duplicate-post budget does not swallow the retry.
  const roomMessages = await f.messages(room.activeTaskId);
  expect(roomMessages.some((m: any) => m.text === "Deploy status: green.")).toBe(false);
  const posted = roomMessages.find((m: any) => m.text === "Deploy status: green, retried.");
  expect(posted).toBeTruthy();
  const audio = (posted.attachments ?? []).find((a: any) => a.kind === "audio");
  expect(audio?.mime).toBe("audio/mpeg");

  const own = await f.messages(bot.activeTaskId);
  expect(own.some((m: any) => (m.attachments ?? []).some((a: any) => a.kind === "audio"))).toBe(false);
  expect(f.mp3Files()).toHaveLength(1);
  expect(audio.path.endsWith(f.mp3Files()[0])).toBe(true);
}, { failFirstAudioAppend: true }), 60_000);

it("deletes a parked voice note when the turn is cancelled mid-flight", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Cancelled note bot")).bot;
  const gate = join(f.dataDir, "voice-note-gate");
  f.savePlan({
    [bot.id]: {
      steps: [{ tool: "send_voice_note", arguments: { text: "This note will be cancelled." } }],
      gateFile: gate,
      reply: "Never reached.",
    },
  });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Send a note, then hold.");
  await expect.poll(() => f.mp3Files().length, { timeout: 20_000 }).toBe(1);
  await f.api("/api/bots/" + bot.id + "/interrupt", { threadId: bot.activeTaskId });
  await expect.poll(() => f.mp3Files(), { timeout: 20_000 }).toEqual([]);
}), 90_000);

it("leaves no file and no later-turn attachment when the turn dies mid-synthesis", async () => withVoiceFixture(async (f) => {
  const hold = join(f.dataDir, "tts-hold");
  const baseUrl = await f.serveTts({ holdUntil: hold });
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Racing note bot")).bot;
  f.savePlan({
    [bot.id]: {
      steps: [{ tool: "send_voice_note", arguments: { text: "This note races its own turn." }, expectError: true }],
      reply: "Never reached.",
    },
  });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Send a note, slowly.");
  await expect.poll(() => f.seen.length, { timeout: 20_000 }).toBe(1);
  await f.api("/api/bots/" + bot.id + "/interrupt", { threadId: bot.activeTaskId });
  // The failed settle lands before the provider bytes arrive, so the park meets a fully dead turn instead of racing the cleanup.
  await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30").catch(() => undefined);
  writeFileSync(hold, "release");
  f.savePlan({ [bot.id]: { steps: [], reply: "Follow-up without a note." } });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Just reply in text.");
  expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
  const messages = await f.messages(bot.activeTaskId);
  expect(messages.some((m: any) => (m.attachments ?? []).some((a: any) => a.kind === "audio"))).toBe(false);
  expect(f.mp3Files()).toEqual([]);
}), 90_000);
