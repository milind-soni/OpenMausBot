import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { useAppPreview } from "@/lib/app-preview";
import { cn } from "@/lib/cn";
import { closeFilePreview, useFilePreview, type FilePreview } from "@/lib/file-preview";
import { t } from "@/lib/i18n";
import { useRoomPanel } from "@/lib/room-panel";
import { useStore } from "@/state/store";
import { PANEL_MIN_WIDTH, useComputerPanelResize } from "./computer-panel-resize";
import { FilePreviewContent } from "./HtmlFilePreview";

/** A file from a message, beside the conversation where the Computer panel sits, so the transcript and the message box
 * stay in reach while it is open. It gives way when another panel takes that side, and closes when the chat changes. */
export function FilePreviewPanel({ threadId }: { threadId: string | undefined }) {
  const preview = useFilePreview();
  const appPreview = useAppPreview();
  const roomPanel = useRoomPanel();
  const { state } = useStore();
  const otherPanel = state.computerOpen || state.settingsOpen || state.inspectorOpen || state.activityOpen || appPreview !== null || roomPanel !== null;
  const hadOtherPanel = useRef(otherPanel);
  useEffect(() => {
    if (otherPanel && !hadOtherPanel.current) closeFilePreview();
    hadOtherPanel.current = otherPanel;
  }, [otherPanel]);
  useEffect(() => closeFilePreview, [threadId]);
  if (!preview || otherPanel || state.activeView !== "chat") return null;
  return <FilePane key={`${preview.message.threadId}:${preview.message.messageId}:${preview.path}`} preview={preview} />;
}

function FilePane({ preview }: { preview: FilePreview }) {
  const { dragProps } = useCaptionChrome();
  const { panelWidth, maxWidth, separatorRef, separatorWidth, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd } = useComputerPanelResize();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => closeButton.current?.focus({ preventScroll: true }), []);
  // Taking focus back must not scroll the transcript away from where the person left it.
  const dismiss = () => {
    closeFilePreview();
    if (preview.opener?.isConnected) preview.opener.focus({ preventScroll: true });
  };
  return (
    <aside aria-label={t("attach.besideAria", { name: preview.name })} data-file-preview={preview.path} style={{ width: panelWidth }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.stopPropagation();
        dismiss();
      }}
      className="animate-panel-in relative flex h-full shrink-0 flex-col border-s border-hairline/40 bg-panel motion-reduce:animate-none max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!">
      <div
        ref={separatorRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("computer.resizeAria")}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={separatorWidth ?? undefined}
        tabIndex={0}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={(event) => { setDragging(true); onResizeStart(event); }}
        onPointerMove={onResizeMove}
        onPointerUp={(event) => { setDragging(false); onResizeEnd(event); }}
        onPointerCancel={(event) => { setDragging(false); onResizeEnd(event); }}
        className="absolute inset-y-0 start-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60 max-md:hidden"
      />
      <header {...dragProps} className="ms-1.5 flex items-center gap-1 py-2.5 ps-2.5 pe-3">
        <h2 dir="auto" title={preview.name} className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">{preview.kind === "changes" ? t("changes.title", { name: preview.name }) : preview.name}</h2>
        <button ref={closeButton} type="button" className="ui-icon-button shrink-0" aria-label={t("attach.besideClose")} title={t("attach.besideClose")} onClick={dismiss}><X size={16} /></button>
      </header>
      {/* An HTML file's frame swallows the pointer, so the resize drag would stop the moment it crossed the page. */}
      <div className={cn("ms-1.5 flex min-h-0 flex-1 flex-col overflow-auto px-3 pb-3", dragging && "pointer-events-none")}>
        <FilePreviewContent kind={preview.kind} path={preview.path} name={preview.name} message={preview.message} original={preview.original} fill />
      </div>
    </aside>
  );
}
