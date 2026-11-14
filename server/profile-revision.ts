import { createHash } from "node:crypto";

import type { ProfileRequestChanges } from "../shared/profile-request.ts";
import type { MausColor } from "../shared/wire.ts";

export function profileSnapshot(
  bot: { name: string; title: string; description: string; soul?: string; cwd?: string; notifications?: boolean; speakReplies?: boolean; color?: MausColor; avatarUrl?: string },
): Required<ProfileRequestChanges> {
  return {
    name: bot.name,
    title: bot.title,
    description: bot.description,
    soul: bot.soul ?? "",
    cwd: bot.cwd ?? "",
    notifications: bot.notifications ?? true,
    speakReplies: bot.speakReplies ?? false,
    color: bot.color ?? "green",
    avatarUrl: bot.avatarUrl ?? "",
  };
}

export function profileRevision(
  bot: { name: string; title: string; description: string; soul?: string; cwd?: string; notifications?: boolean; speakReplies?: boolean; color?: MausColor; avatarUrl?: string; lastProfileRequestId?: string },
): string {
  // The private receipt stops an older, interrupted card from applying restored identical text twice.
  return createHash("sha256")
    .update(JSON.stringify({ ...profileSnapshot(bot), lastProfileRequestId: bot.lastProfileRequestId ?? "" }), "utf8")
    .digest("hex");
}
