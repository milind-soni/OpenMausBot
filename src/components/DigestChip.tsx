import { ClipboardList, Layers } from "lucide-react";

import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

/** The work digest as one quiet chip under a reply: how many tool calls the
 * turn made and how many files it changed, with the full digest text as the
 * tooltip. Shown under the same setting as tool chips (Settings → Tool
 * calls), because it is the summary of exactly those. */
export function DigestChip({ message }: { message: Message }) {
  const digest = message.digest;
  if (!digest) return null;
  const tools = digest.tools.reduce((n, tool) => n + tool.count, 0);
  const files = digest.files ? digest.files.changed.length + digest.files.added.length + digest.files.deleted.length : null;
  const label = files === null
    ? t("chat.digestChipNoFiles", { tools })
    : t("chat.digestChip", { tools, files });
  return (
    <div className="flex justify-start" data-testid="digest-chip">
      <span
        title={message.text ?? t("chat.digestTitle")}
        className="inline-flex max-w-[480px] items-center gap-1.5 rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12px] text-ink-secondary"
      >
        <ClipboardList size={12} />
        <span className="truncate">{label}</span>
      </span>
    </div>
  );
}

/** A compaction record: from here on, rebuilds of this thread's context
 * carry the summary instead of the earlier messages. */
export function CompactionChip({ message }: { message: Message }) {
  const compaction = message.compaction;
  if (!compaction) return null;
  return (
    <div className="flex justify-start" data-testid="compaction-chip">
      <span
        title={`${t("chat.compactionTitle")}\n\n${compaction.summary}`}
        className="inline-flex max-w-[480px] items-center gap-1.5 rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12px] text-ink-secondary"
      >
        <Layers size={12} />
        <span className="truncate">{t("chat.compactionChip", { tokens: compaction.tokensBefore.toLocaleString() })}</span>
      </span>
    </div>
  );
}
