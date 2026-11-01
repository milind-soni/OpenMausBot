import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Share } from "lucide-react";

import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import {
  copyTranscriptToClipboard,
  downloadMarkdownTranscript,
  formatTranscriptMarkdown,
  slugifyTranscriptFilename,
} from "@/lib/export-transcript";
import type { Message } from "@/state/store";
import { MENU_HEADING, MENU_SHEET } from "./menu-recipe";
import { t } from "@/lib/i18n";


export interface ExportTranscriptMenuProps {
  title: string;
  messages: readonly Message[];
  botName?: string;
  isGroup?: boolean;
  className?: string;
}

export function ExportTranscriptMenu({
  title,
  messages,
  botName,
  isGroup = false,
  className,
}: ExportTranscriptMenuProps) {
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const hasMessages = messages && messages.length > 0;

  const handleCopy = async () => {
    if (!hasMessages) return;
    const markdown = formatTranscriptMarkdown({
      title,
      messages,
      botName,
      isGroup,
    });
    const success = await copyTranscriptToClipboard(markdown);
    setCopyFailed(!success);
    if (success) {
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 2_000);
    }
  };

  const handleDownload = () => {
    if (!hasMessages) return;
    const markdown = formatTranscriptMarkdown({
      title,
      messages,
      botName,
      isGroup,
    });
    const filename = slugifyTranscriptFilename(title);
    downloadMarkdownTranscript(filename, markdown);
    setOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={t("ui.exportTranscriptMenu.exportConversation")}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex size-8 items-center justify-center rounded-full transition-colors hover:bg-ink/[0.06]",
          open ? "text-accent" : "text-ink-secondary hover:text-ink",
          className,
        )}
        title={t("ui.exportTranscriptMenu.exportConversationAsMarkdown")}
      >
        <Share size={18} />
      </button>

      {motion.shown && (
        <div
          role="menu"
          aria-label={t("ui.exportTranscriptMenu.exportOptions")}
          className={cn("absolute right-0 top-full z-40 mt-1 w-[220px] overflow-hidden", MENU_SHEET, motion.className)} {...motion.exitProps}
        >
          <div className={MENU_HEADING}>
            {t("ui.exportTranscriptMenu.exportConversation2")}
          </div>

          {!hasMessages ? (
            <div className="px-2 py-1.5 text-[12px] text-ink-secondary">
              {t("ui.exportTranscriptMenu.noMessagesToExportYet")}
            </div>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleCopy()}
                className="ui-menu-row text-ink"
              >
                {copied ? (
                  <Check size={16} className="shrink-0 text-success" />
                ) : (
                  <Copy size={16} className="shrink-0 text-ink-secondary" />
                )}
                <span className="flex-1 truncate">
                  {copied ? t("ui.exportTranscriptMenu.copiedToClipboard") : t("chat.export.copy")}
                </span>
              </button>

              {copyFailed && (
                <div role="status" className="px-2 py-1.5 text-[12px] text-ink-secondary">
                  {t("ui.exportTranscriptMenu.clipboardUnavailableDownloadTheMarkdownFileInstead")}
                </div>
              )}

              <button
                type="button"
                role="menuitem"
                onClick={handleDownload}
                className="ui-menu-row text-ink"
              >
                <Download size={16} className="shrink-0 text-ink-secondary" />
                <span className="flex-1 truncate">{t("chat.export.download")}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
