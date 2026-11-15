import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Pin, PinOff } from "lucide-react";
import type { Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { peerLine } from "@/lib/peer-message";
import { citationPreviewText } from "@/lib/citations";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useMenuMotion } from "./MenuMotion";
import { MENU_LABEL, MENU_SHEET, SIMPLE_MENU_META, SIMPLE_MENU_ROW } from "./menu-recipe";

export type PinnedPreview = { id: string; sender: string; text: string };

export function pinnedPreview(messages: readonly Message[], pinnedId: string | undefined, botName: string, peers = true): PinnedPreview[] {
  const pinned = pinnedId ? messages.find((message) => message.id === pinnedId) : undefined;
  if (!pinned || pinned.kind !== "text") return [];
  const peer = peers ? peerLine(pinned) : null;
  const sender = pinned.role === "user" ? (peer?.name ?? t("chat.you")) : (pinned.from?.name ?? botName);
  const text = citationPreviewText(peer?.body ?? pinned.text ?? "").replace(/\s+/g, " ").trim();
  return text ? [{ id: pinned.id, sender, text }] : [];
}

/** The conversation's pinned messages behind one header button: each row jumps to its message, and Unpin sits beside it. */
export function PinnedMessagesMenu({ pins, onJump, onUnpin, triggerClassName }: {
  pins: readonly PinnedPreview[];
  onJump: (messageId: string) => void;
  onUnpin?: (messageId: string) => void;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, root, () => { setOpen(false); trigger.current?.focus(); });
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);
  if (!pins.length) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? items[(at + 1) % items.length]
      : event.key === "ArrowUp" ? items[(at - 1 + items.length) % items.length]
      : event.key === "Home" ? items[0]
      : event.key === "End" ? items[items.length - 1]
      : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div ref={root} data-pinned-menu className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((shown) => !shown)}
        aria-label={t("chat.pinnedMessages")}
        title={t("chat.pinnedMessages")}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn("flex size-8 items-center justify-center rounded-full text-ink-secondary hover:text-ink aria-expanded:text-accent", triggerClassName)}
      >
        <Pin size={16} />
      </button>
      {motion.shown && (
        <div
          ref={menu}
          role="menu"
          aria-label={t("chat.pinnedMessages")}
          onKeyDown={onKeyDown}
          className={cn("absolute end-0 top-full z-40 mt-1.5 w-80 max-w-[calc(100vw-1rem)]", MENU_SHEET, motion.className)}
          {...motion.exitProps}
        >
          <div className={MENU_LABEL}>{t("chat.pinnedMessages")}</div>
          {pins.map((pin) => (
            <div key={pin.id} className="flex items-start gap-1">
              <button
                type="button"
                role="menuitem"
                data-pinned-jump={pin.id}
                title={t("chat.pinnedJump")}
                onClick={() => { setOpen(false); onJump(pin.id); }}
                className={cn(SIMPLE_MENU_ROW, "flex-1 flex-col items-start gap-0 py-1.5")}
              >
                <span className={SIMPLE_MENU_META}>{pin.sender}</span>
                <span dir="auto" className="line-clamp-2 w-full [overflow-wrap:anywhere]">{pin.text}</span>
              </button>
              {onUnpin && (
                <button
                  type="button"
                  role="menuitem"
                  aria-label={t("chat.unpinMessage")}
                  title={t("chat.unpin")}
                  onClick={() => onUnpin(pin.id)}
                  className="flex size-[30px] shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-ink/[0.06] hover:text-ink focus:bg-ink/[0.06] focus:text-ink touch:size-10"
                >
                  <PinOff size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
