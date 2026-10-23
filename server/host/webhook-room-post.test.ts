import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { WebhookTrigger } from "../../shared/webhooks.ts";
import { __resetAttachmentAccountingForTests, ATTACHMENTS_DIR } from "../attachments.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import type { RoomTalksVerdict } from "./room-access.ts";
import { createWebhookRoomPost } from "./webhook-room-deps.ts";
import { parseRoomPostPayload, postWebhookToRoom, type RoomPostDeps, type RoomPostRoom } from "./webhook-room-post.ts";

const limits = { maxTextChars: 200, maxVoiceChars: 1_000, maxImages: 4, maxImageBytes: 64 };

// threadId deliberately differs from id: a receipt that reports the room id as the thread would pass the wrong way round.
const room: RoomPostRoom = { id: "room-1", threadId: "room-1-thread", dm: false, memberIds: ["maus-1"], name: "Ops" };

const trigger = {
  id: "hook-1",
  endpointId: "wh_test",
  name: "Ops brief",
  prompt: "",
  botId: "maus-1",
  runOn: "maus",
  delivery: "post",
  groupId: "room-1",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  deliveryCount: 0,
} as unknown as WebhookTrigger;

type Calls = {
  appended: Array<{ botId: string; roomId: string; content: { text: string; attachments?: Array<{ kind: string; path: string; mime: string }> } }>;
  synthesized: Array<{ botId: string; text: string }>;
  savedAudio: string[];
  savedImages: string[];
  removed: string[];
};

function deps(overrides: Partial<RoomPostDeps> = {}): { deps: RoomPostDeps; calls: Calls } {
  const calls: Calls = { appended: [], synthesized: [], savedAudio: [], savedImages: [], removed: [] };
  const base: RoomPostDeps = {
    limits,
    room: (groupId) => (groupId === room.id ? room : undefined),
    checkBotRoom: () => ({ ok: true }),
    voiceAllowed: () => true,
    synthesize: async (botId, text) => {
      calls.synthesized.push({ botId, text });
      return { bytes: Buffer.from("pcm"), mime: "audio/mpeg" };
    },
    saveAudio: (_bytes, mime) => {
      const path = `/audio/${calls.savedAudio.length}.mp3`;
      calls.savedAudio.push(path);
      return { path, mime };
    },
    saveImage: (_bytes, mime) => {
      const path = `/image/${calls.savedImages.length}.png`;
      calls.savedImages.push(path);
      return { path, mime };
    },
    removeStaged: (path) => {
      calls.removed.push(path);
    },
    appendRoomPost: (_trigger, botId, target, content) => {
      calls.appended.push({ botId, roomId: target.id, content });
    },
  };
  return { deps: { ...base, ...overrides }, calls };
}

const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest-of-png")]);
const png = pngBytes.toString("base64");

function status(run: () => unknown): number | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { status?: number }).status;
  }
}

describe("parseRoomPostPayload", () => {
  it("rejects a missing or empty text before touching storage", () => {
    expect(() => parseRoomPostPayload({}, limits)).toThrow(/non-empty "text"/);
    expect(() => parseRoomPostPayload({ text: "   " }, limits)).toThrow(/non-empty "text"/);
    expect(() => parseRoomPostPayload({ text: "x".repeat(limits.maxTextChars + 1) }, limits)).toThrow(/at most 200 characters/);
  });

  it("reads a voice note and images, and enforces every ceiling", () => {
    const parsed = parseRoomPostPayload({ text: " brief ", voiceNote: " hello ", images: [{ data: png, mime: "image/png" }] }, limits);
    expect(parsed.text).toBe("brief");
    expect(parsed.voiceNoteText).toBe("hello");
    expect(parsed.imageBytes).toHaveLength(1);
    expect(parsed.imageMimes).toEqual(["image/png"]);

    expect(status(() => parseRoomPostPayload({ text: "x", voiceNote: "y".repeat(limits.maxVoiceChars + 1) }, limits))).toBe(413);
    expect(() => parseRoomPostPayload({ text: "x", voiceNote: "" }, limits)).toThrow(/non-empty string/);
    expect(() => parseRoomPostPayload({ text: "x", images: Array.from({ length: 5 }, () => ({ data: png, mime: "image/png" })) }, limits))
      .toThrow(/at most 4 images/);
    expect(status(() => parseRoomPostPayload({ text: "x", images: [{ data: Buffer.alloc(limits.maxImageBytes + 1).toString("base64"), mime: "image/png" }] }, limits))).toBe(413);
    expect(() => parseRoomPostPayload({ text: "x", images: [{ data: png, mime: "application/pdf" }] }, limits)).toThrow(/supported "mime"/);
  });

  it("accepts real image signatures and rejects a payload mislabelled as one", () => {
    const accepts = (bytes: Buffer, mime: string) =>
      expect(parseRoomPostPayload({ text: "x", images: [{ data: bytes.toString("base64"), mime }] }, limits).imageBytes).toHaveLength(1);
    accepts(pngBytes, "image/png");
    accepts(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]), "image/jpeg");
    accepts(Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from("gif-body")]), "image/gif");
    accepts(Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"), Buffer.from("vp8!")]), "image/webp");
    expect(status(() => parseRoomPostPayload({ text: "x", images: [{ data: Buffer.from("<script>alert(1)</script>").toString("base64"), mime: "image/png" }] }, limits))).toBe(400);
    expect(status(() => parseRoomPostPayload({ text: "x", images: [{ data: png, mime: "image/jpeg" }] }, limits))).toBe(400);
  });
});

describe("postWebhookToRoom", () => {
  it("appends exactly one bot-authored message to the room thread", async () => {
    const h = deps();
    const result = await postWebhookToRoom(h.deps, trigger, { text: "Pipeline is green" });

    expect(result).toEqual({ posted: true, attachments: 0, threadId: "room-1-thread" });
    expect(h.calls.appended).toHaveLength(1);
    expect(h.calls.appended[0]).toEqual({
      botId: "maus-1",
      roomId: "room-1",
      content: { text: "Pipeline is green" },
    });
    expect(h.calls.appended[0]!.content).not.toHaveProperty("attachments");
  });

  it("attaches one audio note synthesized in the bot's voice, first among attachments", async () => {
    const h = deps();
    const result = await postWebhookToRoom(h.deps, trigger, { text: "Listen up", voiceNote: "hello there", images: [{ data: png, mime: "image/png" }] });

    expect(h.calls.synthesized).toEqual([{ botId: "maus-1", text: "hello there" }]);
    expect(result).toEqual({ posted: true, attachments: 2, threadId: "room-1-thread" });
    expect(h.calls.appended[0]!.content.attachments).toEqual([
      { kind: "audio", path: "/audio/0.mp3", mime: "audio/mpeg", text: "hello there" },
      { kind: "image", path: "/image/0.png", mime: "image/png" },
    ]);
  });

  it("stores nothing and appends nothing when synthesis fails, and never touches images first", async () => {
    const h = deps({ synthesize: async () => { throw Object.assign(new Error("the voice engine is asleep"), { status: 503 }); } });
    await expect(postWebhookToRoom(h.deps, trigger, { text: " hi ", voiceNote: "hi", images: [{ data: png, mime: "image/png" }] }))
      .rejects.toThrow("the voice engine is asleep");
    expect(h.calls.savedImages).toEqual([]);
    expect(h.calls.savedAudio).toEqual([]);
    expect(h.calls.appended).toEqual([]);
  });

  it("refuses a voice note for a bot with voice notes off and stores no images either", async () => {
    const h = deps({ voiceAllowed: () => false });
    await expect(postWebhookToRoom(h.deps, trigger, { text: "hi", voiceNote: "hi", images: [{ data: png, mime: "image/png" }] }))
      .rejects.toThrow(/voice notes are turned off/);
    expect(h.calls.synthesized).toEqual([]);
    expect(h.calls.savedImages).toEqual([]);
    expect(h.calls.appended).toEqual([]);
  });

  it("deletes every staged file when a later step fails", async () => {
    const audioDies = deps({ saveImage: () => { throw Object.assign(new Error("the disk is full"), { status: 500 }); } });
    await expect(postWebhookToRoom(audioDies.deps, trigger, { text: "hi", voiceNote: "hi", images: [{ data: png, mime: "image/png" }] }))
      .rejects.toThrow("the disk is full");
    expect(audioDies.calls.savedAudio).toEqual(["/audio/0.mp3"]);
    expect(audioDies.calls.removed).toEqual(["/audio/0.mp3"]);

    const secondImageDies = deps({
      saveImage: (_bytes, mime) => {
        if (secondImageDies.calls.savedImages.length >= 1) throw Object.assign(new Error("second image rejected"), { status: 500 });
        const path = `/image/${secondImageDies.calls.savedImages.length}.png`;
        secondImageDies.calls.savedImages.push(path);
        return { path, mime };
      },
    });
    await expect(postWebhookToRoom(secondImageDies.deps, trigger, { text: "hi", voiceNote: "hi", images: [{ data: png, mime: "image/png" }, { data: png, mime: "image/png" }] }))
      .rejects.toThrow("second image rejected");
    expect(secondImageDies.calls.removed).toEqual(["/audio/0.mp3", "/image/0.png"]);

    const appendDies = deps({ appendRoomPost: () => { throw Object.assign(new Error("the bot or room disappeared mid-delivery"), { status: 404 }); } });
    await expect(postWebhookToRoom(appendDies.deps, trigger, { text: "hi", voiceNote: "hi", images: [{ data: png, mime: "image/png" }] }))
      .rejects.toThrow("disappeared mid-delivery");
    expect(appendDies.calls.removed).toEqual(["/audio/0.mp3", "/image/0.png"]);
    expect(appendDies.calls.appended).toEqual([]);
  });

  it("attaches every accepted image", async () => {
    const h = deps();
    const result = await postWebhookToRoom(h.deps, trigger, {
      text: "chart",
      images: Array.from({ length: 4 }, () => ({ data: png, mime: "image/png" })),
    });
    expect(result).toEqual({ posted: true, attachments: 4, threadId: "room-1-thread" });
    expect(h.calls.savedImages).toHaveLength(4);
    expect(h.calls.appended[0]!.content.attachments?.map((attachment) => attachment.kind)).toEqual(["image", "image", "image", "image"]);
  });

  it("reports the room's thread, never the room id, for a plain post", async () => {
    const h = deps();
    const result = await postWebhookToRoom(h.deps, trigger, { text: "hi" });
    expect(result).toEqual({ posted: true, attachments: 0, threadId: "room-1-thread" });
    expect(result.threadId).not.toBe(room.id);
  });

  it("rejects a non-member before staging anything", async () => {
    const h = deps({ checkBotRoom: () => ({ ok: false as const, status: 403, error: "that bot is not a member of that room" }) });
    await expect(postWebhookToRoom(h.deps, trigger, { text: "hi", voiceNote: "hi", images: [{ data: png, mime: "image/png" }] }))
      .rejects.toThrow("not a member");
    expect(h.calls.savedAudio).toEqual([]);
    expect(h.calls.savedImages).toEqual([]);
    expect(h.calls.appended).toEqual([]);
  });

  it("rejects a payload with no text and a webhook with no room", async () => {
    const h = deps();
    await expect(postWebhookToRoom(h.deps, trigger, { voiceNote: "hi" })).rejects.toThrow(/non-empty "text"/);
    expect(h.calls.appended).toEqual([]);

    const homeless = deps({ room: () => undefined });
    await expect(postWebhookToRoom(homeless.deps, trigger, { text: "hi" })).rejects.toThrow(/room no longer exists/);
    const noGroup = deps();
    await expect(postWebhookToRoom(noGroup.deps, { ...trigger, groupId: undefined } as WebhookTrigger, { text: "hi" }))
      .rejects.toThrow(/no room to post to/);
  });
});

describe("createWebhookRoomPost", () => {
  const stored = () => (existsSync(ATTACHMENTS_DIR) ? readdirSync(ATTACHMENTS_DIR).filter((name) => !name.startsWith(".")) : []);
  function host(cfg: Record<string, unknown>, fetchImpl: typeof fetch) {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    __resetAttachmentAccountingForTests();
    const group = { id: "room-1", threadId: "room-1-thread", name: "Ops", dm: false, memberIds: ["maus-1"], section: "Build" } as unknown as GroupRecord;
    const bot = { id: "maus-1", name: "Maus", color: "teal", section: "Build", voice: "voice-1" } as unknown as BotRecord;
    const appended: Array<{ threadId: string; message: Record<string, unknown> }> = [];
    const store = {
      bot: (id: string) => (id === bot.id ? bot : undefined),
      group: (id: string) => (id === group.id ? group : undefined),
      appendMessage: (threadId: string, message: Record<string, unknown>) => appended.push({ threadId, message }),
      patchGroup: () => group,
    } as unknown as Store;
    const { roomPost, roomMember } = createWebhookRoomPost({
      store,
      cfg: cfg as never,
      roomTalks: (speaker, target): RoomTalksVerdict =>
        target.memberIds.includes(speaker.id) ? { ok: true } : { ok: false, problem: "not-member" },
    });
    globalThis.fetch = fetchImpl;
    return { group, appended, roomPost: roomPost!, roomMember: roomMember! };
  }
  const chatterbox = { tts: { provider: "chatterbox", baseUrl: "http://127.0.0.1:9", voice: "voice-1" } };
  const mp3 = (async () => new Response(new Uint8Array([0xff, 0xf1, 0xa0]), { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch;
  const image = { data: pngBytes.toString("base64"), mime: "image/png" };
  const realFetch = globalThis.fetch;
  const restore = () => { globalThis.fetch = realFetch; };

  it("appends one bot-authored webhook line with the voice note and the image, both stored", async () => {
    try {
      const h = host(chatterbox, mp3);
      const result = await h.roomPost({ ...trigger, groupId: "room-1" } as WebhookTrigger, { text: "Deploy done", voiceNote: "deploy done", images: [image] });
      expect(result).toEqual({ posted: true, attachments: 2, threadId: "room-1-thread" });
      expect(h.appended).toHaveLength(1);
      expect(h.appended[0]).toMatchObject({
        threadId: "room-1-thread",
        message: { role: "bot", kind: "text", text: "Deploy done", from: { botId: "maus-1", name: "Maus", color: "teal" }, webhookPost: true,
          attachments: [{ kind: "audio", mime: "audio/mpeg" }, { kind: "image", mime: "image/png" }] },
      });
      expect(stored()).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it("re-checks the room after synthesis and deletes every staged file when the room turned it down", async () => {
    try {
      const h = host(chatterbox, (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        return new Response(new Uint8Array([0xff, 0xf1, 0xa0]), { status: 200, headers: { "content-type": "audio/mpeg" } });
      }) as typeof fetch);
      const delivery = h.roomPost({ ...trigger, groupId: "room-1" } as WebhookTrigger, { text: "Deploy done", voiceNote: "deploy done", images: [image] });
      // The bot leaves the room while the voice note is still being synthesized.
      await new Promise((resolve) => setTimeout(resolve, 10));
      h.group.memberIds = ["someone-else"];

      await expect(delivery).rejects.toMatchObject({ status: 403, message: "@Maus is not a member of the room “Ops”. Add @Maus to the room, or point the webhook at a room it is in." });
      expect(h.appended).toEqual([]);
      expect(stored()).toEqual([]);
    } finally {
      restore();
    }
  });

  it("answers 409 with the owner's next step when no voice is set up, and stores nothing", async () => {
    try {
      const h = host({ tts: { provider: "chatterbox", voice: "voice-1" } }, mp3);
      await expect(h.roomPost({ ...trigger, groupId: "room-1" } as WebhookTrigger, { text: "Deploy done", voiceNote: "deploy done", images: [image] }))
        .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/^The voice note could not be made: Add the address of your Chatterbox server/) });
      expect(h.appended).toEqual([]);
      expect(stored()).toEqual([]);
    } finally {
      restore();
    }
  });

  it("never passes a voice provider's own 401 through as the webhook's", async () => {
    try {
      const h = host(chatterbox, (async () => new Response("bad key", { status: 401 })) as typeof fetch);
      const failure = await h.roomPost({ ...trigger, groupId: "room-1" } as WebhookTrigger, { text: "Deploy done", voiceNote: "deploy done" })
        .catch((error: { status?: number; message: string }) => error);
      expect(failure).toMatchObject({ status: 502, message: expect.stringMatching(/^The voice note could not be made: /) });
      expect(h.appended).toEqual([]);
    } finally {
      restore();
    }
  });

  it("names the room and the way out when the bot is not in it, and when the room is gone", () => {
    const h = host(chatterbox, mp3);
    restore();
    expect(h.roomMember("maus-1", "room-1")).toEqual({ ok: true });
    h.group.memberIds = ["someone-else"];
    expect(h.roomMember("maus-1", "room-1")).toEqual({ ok: false, status: 403,
      error: "@Maus is not a member of the room “Ops”. Add @Maus to the room, or point the webhook at a room it is in." });
    expect(h.roomMember("maus-1", "room-gone")).toEqual({ ok: false, status: 404,
      error: "The room this webhook posts to no longer exists. Point the webhook at another room, or delete it." });
  });
});
