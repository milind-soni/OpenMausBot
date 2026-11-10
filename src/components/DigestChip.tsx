import { useState } from "react";
import { ClipboardList } from "lucide-react";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { formatDuration } from "@/lib/usage-trace";
import type { Message } from "@/state/store";
import { traceRootId } from "../../shared/usage-trace";
import { EXCERPT_SUMMARY_HEADER } from "../../shared/wire";
import { TraceDialog } from "./usage/TraceView";

const WORK_KEY: Record<"noFiles" | "oneFile" | "files", Record<"oneTool" | "tools", LocaleKey>> = {
  noFiles: { oneTool: "chat.digestChipNoFilesOne", tools: "chat.digestChipNoFiles" },
  oneFile: { oneTool: "chat.digestChipOneEach", tools: "chat.digestChipOneFile" },
  files: { oneTool: "chat.digestChipOneTool", tools: "chat.digestChip" },
};
const one = (count: number | string) => String(count) === "1";

export function DigestChip({ message }: { message: Message }) {
  const [tracing, setTracing] = useState(false);
  const digest = message.digest;
  if (!digest) return null;
  const files = digest.files ? digest.files.changed.length + digest.files.added.length + digest.files.deleted.length + (digest.files.truncated ?? 0) : null;
  const worked = digest.tools.length || digest.toolCalls || digest.toolsDropped || files || digest.memory.length || digest.memoryDropped;
  const tools = digest.toolCalls ?? `${digest.tools.reduce((n, tool) => n + tool.count, 0)}${digest.toolsDropped ? "+" : ""}`;
  const label = [
    digest.durationMs > 0 ? t("trace.workedFor", { duration: formatDuration(digest.durationMs) }) : null,
    worked ? t(WORK_KEY[files === null ? "noFiles" : one(files) ? "oneFile" : "files"][one(tools) ? "oneTool" : "tools"], { tools, files: files ?? 0 }) : null,
  ].filter(Boolean).join(" · ");
  if (!label) return null;
  return (
    <div className="flex justify-start" data-testid="digest-chip">
      <span
        title={message.text ?? t("chat.digestTitle")}
        className="ui-chip max-w-[min(520px,100%)] border border-hairline/40 bg-panel text-ink-secondary"
      >
        <ClipboardList size={12} />
        <span className="truncate">{label}</span>
        <button type="button" onClick={() => setTracing(true)} className="shrink-0 text-accent hover:underline" data-testid="view-trace">
          {t("trace.view")}
        </button>
      </span>
      {tracing && <TraceDialog id={traceRootId(digest.threadId, digest.turnId)} at={digest.at} onClose={() => setTracing(false)} />}
    </div>
  );
}

const COMPACTION_CHIP = "max-w-[600px] rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary";

export function CompactionChip({ message }: { message: Message }) {
  if (!message.compaction) return message.engineCompaction ? (
    <div className={COMPACTION_CHIP} data-testid="engine-compaction-chip">
      <p className="font-medium">{t("chat.engineCompactionTitle")}</p>
      <p className="mt-1">{t("chat.engineCompactionHint")}</p>
    </div>
  ) : null;
  const excerpts = message.compaction.summary.startsWith(EXCERPT_SUMMARY_HEADER);
  return (
    <details className={COMPACTION_CHIP} data-testid="compaction-chip">
      <summary className="cursor-pointer font-medium">{t(excerpts ? "chat.compactionExcerptTitle" : "chat.compactionTitle")}</summary>
      <p className="mt-2">{t(excerpts ? "chat.compactionExcerptHint" : "chat.compactionHint")}</p>
      <p className="mt-2 whitespace-pre-wrap break-words">{message.compaction.summary}</p>
    </details>
  );
}
