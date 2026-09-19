import { FileText, X } from "lucide-react";
import type { CalendarCallAttachment } from "@/lib/calendar-calls";
import type { RoutineContextAttachment } from "../../../shared/routines";

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: Array<RoutineContextAttachment | CalendarCallAttachment>;
  onRemove?: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="flex max-w-[260px] items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-2.5 py-2 text-[12px] text-ink">
          <FileText size={14} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
          {onRemove && <button type="button" onClick={() => onRemove(attachment.id)} className="rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={`Remove ${attachment.name}`}><X size={12} /></button>}
        </div>
      ))}
    </div>
  );
}
