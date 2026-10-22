import { ClipboardList } from "lucide-react";

import { t } from "@/lib/i18n";
import { EXCERPT_SUMMARY_HEADER } from "../../shared/wire";
import type { Message } from "@/state/store";

export function DigestChip({ message }: { message: Message }) {
  const digest = message.digest;
  if (!digest) return null;
  const files = digest.files ? digest.files.changed.length + digest.files.added.length + digest.files.deleted.length + (digest.files.truncated ?? 0) : null;
  if (!digest.tools.length && !digest.toolCalls && !digest.toolsDropped &&
      !files && !digest.memory.length && !digest.memoryDropped) return null;
  const tools = digest.toolCalls ?? `${digest.tools.reduce((n, tool) => n + tool.count, 0)}${digest.toolsDropped ? "+" : ""}`;
  const label = files === null
    ? t("chat.digestChipNoFiles", { tools })
    : t("chat.digestChip", { tools, files });
  return (
    <div className="flex justify-start" data-testid="digest-chip">
      <span
        title={message.text ?? t("chat.digestTitle")}
        className="ui-chip max-w-[min(480px,100%)] border border-hairline/40 bg-panel text-ink-secondary"
      >
        <ClipboardList size={12} />
        <span className="truncate">{label}</span>
      </span>
    </div>
  );
}

export function CompactionChip({ message }: { message: Message }) {
  if (!message.compaction) return null;
  const excerpts = message.compaction.summary.startsWith(EXCERPT_SUMMARY_HEADER);
  return (
    <details className="max-w-[600px] rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary" data-testid="compaction-chip">
      <summary className="cursor-pointer font-medium">{t(excerpts ? "chat.compactionExcerptTitle" : "chat.compactionTitle")}</summary>
      <p className="mt-2">{t(excerpts ? "chat.compactionExcerptHint" : "chat.compactionHint")}</p>
      <p className="mt-2 whitespace-pre-wrap break-words">{message.compaction.summary}</p>
    </details>
  );
}
