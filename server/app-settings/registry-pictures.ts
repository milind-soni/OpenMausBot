// A bot's picture and the person's own, from a picture file the bot names; each applies with Undo through the same
// routes Settings uses, so their checks still run.
import { basename } from "node:path";

import { z } from "zod";

import { AVATAR_FOCUS_CENTER, AVATAR_ZOOM_MIN, botAvatarProfile, type BotAvatarCrop } from "../../shared/bot-avatar.ts";
import type { BotRecord } from "../store.ts";
import { PICTURE_FILE_KINDS, PICTURE_FILE_MAX_BYTES } from "./picture-file.ts";
import { withoutKeys, type RegistryDeps, type SettingEntry, type WritableSpec } from "./registry.ts";

const path = z.string().trim().max(4096);
const SOURCE = `${PICTURE_FILE_KINDS} of up to ${PICTURE_FILE_MAX_BYTES / 1024 / 1024} MB in your workspace, your working folder or this conversation's files`;

/** From the bot: `path`, empty to take the picture off. From the host: the stored `avatarUrl`. From Undo: the look before. */
type BotPicture = { botId: string; path?: string; avatarUrl?: string; avatarCrop?: BotAvatarCrop; avatarZoom?: number; avatarFocusX?: number; avatarFocusY?: number };
type OwnPicture = { path?: string; avatarUrl?: string };

const pictureShown = (one: BotRecord) => Boolean(botAvatarProfile(one).avatarUrl) && botAvatarProfile(one).avatarCrop !== "mascot";
const MASCOT_LOOK = { avatarUrl: null, avatarCrop: "mascot", avatarZoom: AVATAR_ZOOM_MIN, avatarFocusX: AVATAR_FOCUS_CENTER, avatarFocusY: AVATAR_FOCUS_CENTER } as const;

export function pictureEntries(deps: Pick<RegistryDeps, "bots" | "patchBot" | "cfg" | "saveConfig">, writable: (spec: WritableSpec) => SettingEntry): SettingEntry[] {
  const bot = (id: string) => deps.bots().find((candidate) => candidate.id === id);
  const missing = (id: string) => `No bot has the id ${id}. Use list_bots for the ids.`;
  const ownPicture = () => deps.cfg().profile?.avatarUrl ?? "";
  return [
    writable({
      id: "bots.picture", label: "Bot picture", where: "a bot's Settings", fromFile: true,
      help: "A bot's own picture, shown instead of its mascot face wherever the bot appears. Use a picture file you have: one you made or downloaded, or one the person sent in this conversation.",
      synonyms: ["picture", "avatar", "photo", "image", "profile picture", "icon", "face", "pfp", "bot picture"],
      value: withoutKeys(z.object({ botId: z.string().regex(/^[\w-]{1,120}$/), path }).strict()),
      allowed: `{"botId","path"}: path is ${SOURCE}; an empty path takes the picture off and brings back the mascot face`,
      read: () => deps.bots().map((one) => `${one.name}: ${pictureShown(one) ? one.avatarUrl : "mascot face"}`).join("; "),
      describe: ({ botId, path: file }: BotPicture) => {
        const one = bot(botId);
        if (!one) return { refusal: missing(botId) };
        if (file) return { change: `Give ${one.name} the picture ${basename(file)}` };
        return pictureShown(one) ? { change: `Take ${one.name}'s picture off; it shows its mascot face again` } : { refusal: `${one.name} has no picture; it already shows its mascot face.` };
      },
      current: ({ botId }: BotPicture): BotPicture | undefined => {
        const one = bot(botId);
        return one && { botId, avatarUrl: one.avatarUrl ?? "", avatarCrop: one.avatarCrop ?? "mascot", avatarZoom: one.avatarZoom ?? AVATAR_ZOOM_MIN,
          avatarFocusX: one.avatarFocusX ?? AVATAR_FOCUS_CENTER, avatarFocusY: one.avatarFocusY ?? AVATAR_FOCUS_CENTER };
      },
      write: async (value: BotPicture) => {
        const one = bot(value.botId);
        if (!one) return missing(value.botId);
        if (value.path !== undefined) return deps.patchBot(one.id, { ...MASCOT_LOOK });
        const crop = one.avatarCrop && one.avatarCrop !== "mascot" ? one.avatarCrop : "circle";
        return deps.patchBot(one.id, { avatarUrl: value.avatarUrl || null, avatarCrop: value.avatarCrop ?? crop, avatarZoom: value.avatarZoom ?? AVATAR_ZOOM_MIN,
          avatarFocusX: value.avatarFocusX ?? AVATAR_FOCUS_CENTER, avatarFocusY: value.avatarFocusY ?? AVATAR_FOCUS_CENTER });
      },
    }),
    writable({
      id: "profile.photo", label: "Your photo", where: "Settings → You and your bots", fromFile: true,
      help: "The person's own picture, shown wherever the app shows them. Use a picture file you have: one you made or downloaded, or one the person sent in this conversation.",
      synonyms: ["photo", "avatar", "profile picture", "my picture", "my photo", "pfp", "picture of me"],
      value: z.object({ path }).strict(), allowed: `{"path"}: path is ${SOURCE}; an empty path takes the photo off`,
      read: ownPicture, current: (): OwnPicture => ({ avatarUrl: ownPicture() }),
      describe: ({ path: file }: OwnPicture) => (file ? { change: `Make ${basename(file)} your photo` }
        : ownPicture() ? { change: "Take your photo off" } : { refusal: "The person has no photo to take off." }),
      write: (value: OwnPicture) => deps.saveConfig({ profile: { avatarUrl: value.path !== undefined ? "" : value.avatarUrl ?? "" } }),
    }),
  ];
}
