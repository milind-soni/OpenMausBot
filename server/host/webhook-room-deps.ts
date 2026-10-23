import { deleteAttachment, IMAGE_MAX_BYTES, saveAudio, saveImage } from "../attachments.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import type { AppConfig } from "../config.ts";
import { redactSecretsInText } from "../redact.ts";
import * as tts from "../tts/index.ts";
import type { WebhookManagerOptions } from "../webhooks.ts";
import type { RoomTalksVerdict } from "./room-access.ts";
import { postWebhookToRoom } from "./webhook-room-post.ts";

export interface WebhookRoomDeps {
  store: Store;
  cfg: AppConfig;
  /** The same membership and section verdict a bot's own post_to_room call gets. */
  roomTalks(bot: BotRecord, group: GroupRecord): RoomTalksVerdict;
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/** A webhook's owner configures it from the dashboard, so refusals name the webhook's bot and room rather than speaking as it. */
function roomPostProblem(bot: BotRecord, group: GroupRecord, verdict: Exclude<RoomTalksVerdict, { ok: true }>): string {
  if (verdict.problem === "dm") return `@${bot.name} reaches that bot in a one-to-one channel; a webhook room post needs a room`;
  if (verdict.problem === "not-member") return `@${bot.name} is not a member of the room “${group.name}”. Add @${bot.name} to the room, or point the webhook at a room it is in.`;
  if (verdict.problem === "outsider") return `the room “${group.name}” includes @${verdict.name}, who is outside @${bot.name}'s section, so @${bot.name} cannot post there`;
  return `the room “${group.name}” is still being set up — it cannot receive messages yet`;
}

const ROOM_GONE = "The room this webhook posts to no longer exists. Point the webhook at another room, or delete it.";

/** The room half of webhook delivery: membership gates at create/patch, and a one-message, bot-authored post per delivery. */
export function createWebhookRoomPost(deps: WebhookRoomDeps): Pick<WebhookManagerOptions, "roomMember" | "roomPost"> {
  const { store, cfg } = deps;
  const botRoom = (botId: string): BotRecord | undefined => {
    const bot = store.bot(botId);
    return bot && !bot.hidden ? bot : undefined;
  };
  const verdict = (botId: string, groupId: string): { ok: true } | { ok: false; status: number; error: string } => {
    const bot = botRoom(botId);
    if (!bot) return { ok: false as const, status: 404, error: "The assigned MAUS no longer exists" };
    const group = store.group(groupId);
    if (!group) return { ok: false as const, status: 404, error: ROOM_GONE };
    const talks = deps.roomTalks(bot, group);
    return talks.ok ? { ok: true as const } : { ok: false as const, status: 403, error: roomPostProblem(bot, group, talks) };
  };
  return {
    roomMember: verdict,
    roomPost: (trigger, payload) => postWebhookToRoom({
      limits: { maxTextChars: 20_000, maxVoiceChars: 1_000, maxImages: 4, maxImageBytes: IMAGE_MAX_BYTES },
      room: (groupId) => {
        const group = store.group(groupId);
        return group ? { id: group.id, threadId: group.threadId, dm: group.dm === true, memberIds: group.memberIds, name: group.name } : undefined;
      },
      checkBotRoom: (botId, room) => verdict(botId, room.id),
      voiceAllowed: (botId) => store.bot(botId)?.voiceNotes !== false,
      synthesize: async (botId, text) => {
        try {
          const audio = await tts.speak(cfg, text, store.bot(botId)?.voice);
          return { bytes: Buffer.from(audio.bytes), mime: audio.mime };
        } catch (error) {
          if (error instanceof tts.NoVoiceConfigured) fail(409, `The voice note could not be made: ${error.message}`);
          // A voice provider's 401 or 429 is not this webhook's: the sender would read it as a wrong secret or its own rate limit.
          fail(502, `The voice note could not be made: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      saveAudio,
      saveImage,
      removeStaged: deleteAttachment,
      appendRoomPost: (_trigger, botId, room, content) => {
        const bot = botRoom(botId);
        const group = store.group(room.id);
        if (!bot) fail(404, "The assigned MAUS no longer exists");
        if (!group) fail(404, ROOM_GONE);
        const talks = deps.roomTalks(bot, group);
        if (!talks.ok) fail(403, roomPostProblem(bot, group, talks));
        store.appendMessage(group.threadId, {
          role: "bot",
          kind: "text",
          text: content.text,
          from: { botId: bot.id, name: bot.name, color: bot.color },
          webhookPost: true,
          ...(content.attachments?.length
            ? { attachments: content.attachments.map((attachment) =>
                attachment.kind === "audio" && attachment.text ? { ...attachment, text: redactSecretsInText(attachment.text) } : attachment) }
            : {}),
        });
        store.patchGroup(group.id, { unread: true });
      },
    }, trigger, payload),
  };
}
