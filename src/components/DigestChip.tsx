import { ClipboardList } from "lucide-react";

import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

/** The work digest as one quiet chip under a reply: how many tool calls the
 * turn made and how many files it changed, with the full digest text as the
 * tooltip. Shown under the same setting as tool chips (Settings → Tool
 * calls), because it is the summary of exactly those. */
export function DigestChip({ message }: { message: Message }) {
  const digest = message.digest;
  if (!digest) return null;
  const tools = digest.toolCalls ?? `${digest.tools.reduce((n, tool) => n + tool.count, 0)}${digest.toolsDropped ? "+" : ""}`;
  const files = digest.files ? digest.files.changed.length + digest.files.added.length + digest.files.deleted.length + (digest.files.truncated ?? 0) : null;
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

/** Context changes are visible even when ordinary tool chips are hidden. */
export function CompactionChip({ message }: { message: Message }) {
  if (!message.compaction) return null;
  return (
    <details className="max-w-[600px] rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary" data-testid="compaction-chip">
      <summary className="cursor-pointer font-medium">{t("chat.compactionTitle")}</summary>
      <p className="mt-2">{t("chat.compactionHint")}</p>
      <p className="mt-2 whitespace-pre-wrap break-words">{message.compaction.summary}</p>
    </details>
  );
}
