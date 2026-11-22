import { lazy, Suspense, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";

import type { MessageAttachmentContext } from "./AttachmentPreview";
import { TableDialog } from "./RichTable";
import { cn } from "@/lib/cn";
import type { EditSource } from "@/lib/edit-source";
import { useFileBesideChat } from "@/lib/file-preview";
import { t } from "@/lib/i18n";

const WhatChangedContent = lazy(() => import("./WhatChangedView"));

/** "What changed" beside a file a bot returned as an edit of the person's file: opens the comparison beside the chat
 * when the window has room, else in a dialog. Nothing loads until it is pressed. */
export function WhatChangedButton({ path, name, message, source, compact = false }: { path: string; name: string; message: MessageAttachmentContext; source: EditSource; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const beside = useFileBesideChat();
  const show = () => {
    if (!beside({ kind: "changes", path, name, message, original: source, opener: trigger.current })) setOpen(true);
  };
  return <>
    <button ref={trigger} type="button" onClick={show} aria-label={t("changes.openAria", { name })} title={t("changes.openAria", { name })}
      className={cn("inline-flex shrink-0 items-center rounded-full px-2.5 leading-none text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus", compact ? "h-7 text-[13px]" : "h-8 text-[12px]")}>
      {t("changes.open")}
    </button>
    {open && <TableDialog title={t("changes.title", { name })} returnFocus={trigger.current} onClose={() => setOpen(false)}>
      <Suspense fallback={<div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t("changes.loading")}</div>}>
        <WhatChangedContent edited={{ path, name, message }} original={{ path: source.path, name: source.name, message: { threadId: message.threadId, messageId: source.messageId } }} />
      </Suspense>
    </TableDialog>}
  </>;
}
