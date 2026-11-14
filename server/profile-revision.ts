import { createHash } from "node:crypto";

import type { ProfileRequestChanges } from "../shared/profile-request.ts";

export function profileSnapshot(
  bot: { name: string; title: string; description: string; soul?: string; cwd?: string; notifications?: boolean; speakReplies?: boolean },
): Required<Omit<ProfileRequestChanges, "browserProfile">> {
  return {
    name: bot.name,
    title: bot.title,
    description: bot.description,
    soul: bot.soul ?? "",
    cwd: bot.cwd ?? "",
    notifications: bot.notifications ?? true,
    speakReplies: bot.speakReplies ?? false,
  };
}

export function profileRevision(
  bot: { name: string; title: string; description: string; soul?: string; cwd?: string; notifications?: boolean; speakReplies?: boolean; lastProfileRequestId?: string },
): string {
  // The private receipt stops an older, interrupted card from applying restored identical text twice.
  return createHash("sha256")
    .update(JSON.stringify({ ...profileSnapshot(bot), lastProfileRequestId: bot.lastProfileRequestId ?? "" }), "utf8")
    .digest("hex");
}
