// The revision token a playbook card pins to. It covers the target's whole
// playbook set rather than just the key being changed: an upsert that lands
// after another card removed a different playbook still changes what the bot
// is told, and the user approved a specific before/after. The profile
// analogue is profile-revision.ts.
import { createHash } from "node:crypto";

import type { InstalledPlaybook } from "./store.ts";

export function playbookSnapshot(bot: { playbooks?: InstalledPlaybook[] }): InstalledPlaybook[] {
  return bot.playbooks ?? [];
}

export function playbookRevision(
  bot: { playbooks?: InstalledPlaybook[]; lastPlaybookRequestId?: string },
): string {
  // A later proposal can restore identical text. Keep its private receipt in
  // the opaque revision so an older, interrupted card cannot apply twice.
  return createHash("sha256")
    .update(
      JSON.stringify({
        playbooks: playbookSnapshot(bot).map((playbook) => ({
          key: playbook.key,
          name: playbook.name,
          summary: playbook.summary,
          triggers: playbook.triggers,
          instructions: playbook.instructions,
          source: playbook.source ?? "package",
        })),
        lastPlaybookRequestId: bot.lastPlaybookRequestId ?? "",
      }),
      "utf8",
    )
    .digest("hex");
}
