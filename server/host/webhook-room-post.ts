import type { WebhookTrigger } from "../../shared/webhooks.ts";

export type RoomPostAttachment =
  | { kind: "image"; path: string; mime: string }
  | { kind: "audio"; path: string; mime: string; text?: string };

export interface RoomPostContent {
  text: string;
  attachments?: RoomPostAttachment[];
}

/** Loose payload shape read before anything expensive runs; a bad field costs a 400, not a synthesis call. */
export interface RoomPostPayload {
  text: string;
  voiceNoteText: string | null;
  imageBytes: Buffer[];
  imageMimes: string[];
}

export interface RoomPostRoom {
  id: string;
  threadId: string;
  dm: boolean;
  memberIds: readonly string[];
  name: string;
}

export interface RoomPostDeps {
  /** Payload ceilings. `maxImageBytes` matches the server's image upload cap; `maxTextChars` matches the post-delivery cap. */
  limits: { maxTextChars: number; maxVoiceChars: number; maxImages: number; maxImageBytes: number };
  room(groupId: string): RoomPostRoom | undefined;
  /** Membership and section rules, re-read at delivery time, never taken from the trigger record alone. */
  checkBotRoom(botId: string, room: RoomPostRoom): { ok: true } | { ok: false; status: number; error: string };
  voiceAllowed(botId: string): boolean;
  synthesize(botId: string, text: string): Promise<{ bytes: Buffer; mime: string }>;
  saveAudio(bytes: Buffer, mime: string): { path: string; mime: string };
  saveImage(bytes: Buffer, mime: string): { path: string; mime: string };
  /** Undo a staged save so a failed delivery leaves no orphaned bytes. */
  removeStaged(path: string): void;
  appendRoomPost(trigger: WebhookTrigger, botId: string, room: RoomPostRoom, content: RoomPostContent): void;
}

export interface RoomPostResult {
  posted: true;
  attachments: number;
  /** The room's conversation thread — never the room id, which is a different identifier. */
  threadId: string;
}

export const WEBHOOK_IMAGE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/** A caller holds the webhook secret, so a declared mime is a preference, not proof: the bytes themselves decide. */
const IMAGE_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a",
  "image/webp": (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseRoomPostPayload(raw: unknown, limits: RoomPostDeps["limits"]): RoomPostPayload {
  const body = record(raw);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) fail(400, "a room post delivery needs a non-empty \"text\"");
  if (text.length > limits.maxTextChars) fail(413, `a room post is at most ${limits.maxTextChars} characters`);

  let voiceNoteText: string | null = null;
  if (body.voiceNote !== undefined && body.voiceNote !== null) {
    if (typeof body.voiceNote !== "string" || !body.voiceNote.trim()) {
      fail(400, "\"voiceNote\" must be a non-empty string when present");
    }
    voiceNoteText = body.voiceNote.trim();
    if (voiceNoteText.length > limits.maxVoiceChars) {
      fail(413, `a voice note is limited to ${limits.maxVoiceChars} characters`);
    }
  }

  const imageBytes: Buffer[] = [];
  const imageMimes: string[] = [];
  if (body.images !== undefined && body.images !== null) {
    if (!Array.isArray(body.images)) fail(400, "\"images\" must be an array of { data, mime }");
    if (body.images.length > limits.maxImages) fail(400, `at most ${limits.maxImages} images per delivery`);
    for (const candidate of body.images) {
      const image = record(candidate);
      if (typeof image.data !== "string" || !image.data) fail(400, "each image needs base64 \"data\"");
      if (typeof image.mime !== "string" || !WEBHOOK_IMAGE_MIMES.has(image.mime)) {
        fail(400, "each image needs a supported \"mime\": image/png, image/jpeg, image/webp or image/gif");
      }
      if (image.data.length > Math.ceil(limits.maxImageBytes / 3) * 4 + 4) {
        fail(413, `an image is limited to ${limits.maxImageBytes} bytes`);
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(image.data, "base64");
      } catch {
        fail(400, "image \"data\" is not valid base64");
      }
      if (!bytes || bytes.byteLength === 0) fail(400, "image \"data\" decoded to nothing");
      if (bytes.byteLength > limits.maxImageBytes) fail(413, `an image is limited to ${limits.maxImageBytes} bytes`);
      if (!IMAGE_SIGNATURES[image.mime]!(bytes)) fail(400, `image "data" is not a valid ${image.mime} file`);
      imageBytes.push(bytes);
      imageMimes.push(image.mime);
    }
  }
  return { text, voiceNoteText, imageBytes, imageMimes };
}

/** Voice is staged first: a refused or failed voice note must not leave stored image files behind. */
async function stageVoiceNote(deps: RoomPostDeps, botId: string, text: string): Promise<{ path: string; mime: string }> {
  if (!deps.voiceAllowed(botId)) fail(403, "voice notes are turned off for this bot");
  const audio = await deps.synthesize(botId, text);
  return deps.saveAudio(Buffer.from(audio.bytes), audio.mime);
}

/** Everything is staged before anything is stored or appended, so a TTS or storage failure posts nothing. */
export async function postWebhookToRoom(
  deps: RoomPostDeps,
  trigger: WebhookTrigger,
  raw: unknown,
): Promise<RoomPostResult> {
  const payload = parseRoomPostPayload(raw, deps.limits);
  const groupId = String(trigger.groupId ?? "").trim();
  if (!groupId) fail(400, "this webhook has no room to post to");
  const room = deps.room(groupId);
  if (!room) fail(404, "the webhook's room no longer exists");
  const eligibility = deps.checkBotRoom(trigger.botId, room);
  if (!eligibility.ok) fail(eligibility.status, eligibility.error);

  const attachments: RoomPostAttachment[] = [];
  try {
    if (payload.voiceNoteText) {
      const audio = await stageVoiceNote(deps, trigger.botId, payload.voiceNoteText);
      attachments.push({ kind: "audio", path: audio.path, mime: audio.mime, text: payload.voiceNoteText });
    }
    for (let index = 0; index < payload.imageBytes.length; index += 1) {
      const saved = deps.saveImage(payload.imageBytes[index]!, payload.imageMimes[index]!);
      attachments.push({ kind: "image", path: saved.path, mime: saved.mime });
    }
    deps.appendRoomPost(trigger, trigger.botId, room, {
      text: payload.text,
      ...(attachments.length ? { attachments } : {}),
    });
  } catch (error) {
    for (const attachment of attachments) deps.removeStaged(attachment.path);
    throw error;
  }
  return { posted: true, attachments: attachments.length, threadId: room.threadId };
}
