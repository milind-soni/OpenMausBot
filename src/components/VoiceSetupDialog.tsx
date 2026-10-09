// Voice set-up, where a call asked for it. The call button's help used to
// send people to the bot's full settings (in Simple mode, the whole Advanced
// fold-out) just to paste a key and pick a voice. This is the same
// VoiceSettings card in a small glass pop-up over the chat, with the bot's
// full Voice section one link away, and the call one click away once a
// voice is ready.
//
// It saves the way the bot's own settings do (the bot update and the
// workspace voice config). A desktop paired to another computer can't make
// those writes (the host keeps the engine and its key), so the call help
// opens the remote agent settings there instead of this.
import { useEffect, useId, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, ChevronRight, Loader2, Phone, X } from "lucide-react";

import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { VoiceSettings } from "./VoiceSettings";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const VOICE_PICKER = "select[data-voice-picker]:not([disabled])";
const FIRST_FIELD = "input:not([disabled]), select:not([disabled])";

export function VoiceSetupDialog({
  bot,
  callName,
  ready,
  onClose,
  onStartCall,
  returnFocusRef,
}: {
  /** Whose voice this sets: the bot being called, or in a room the first
   * member still without one. */
  bot: Bot;
  /** Who the call goes to (a room's name for a group call). */
  callName: string;
  /** The call button's own test, live: a call can start now. */
  ready: boolean;
  onClose: () => void;
  /** Starts the call exactly as the call button does. */
  onStartCall: () => void;
  /** Focus goes back here on close: the call button. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { state, dispatch } = useStore();
  // The patch the bot settings' Voice section hands the same card.
  const { patch } = useBotSettingsDerived(bot);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const subtitleId = useId();
  const close = () => onCloseRef.current();

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (element) => element.getClientRects().length > 0,
      );
    // The voice picker shows once the engine is set up (its key saved, its
    // server address set), and then a voice is what's missing: start there.
    // Until then, start in the first field: the key, or the server address.
    (
      dialog?.querySelector<HTMLElement>(VOICE_PICKER) ??
      dialog?.querySelector<HTMLElement>(FIRST_FIELD) ??
      dialog
    )?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      // Focus falls out when the control holding it goes away (switching
      // engines removes the key field): Tab brings it back either way.
      if (document.activeElement === dialog || !dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      (returnFocusRef?.current ?? previousFocus)?.focus();
    };
  }, [returnFocusRef]);

  // Everything the pop-up leaves out (notifications, the rest of the bot's
  // profile) is in the full settings, opened at Voice. In a room the bot is a
  // member, so open its chat first, as the call help always did.
  const openAllSettings = () => {
    close();
    if (state.selectedId !== bot.id) dispatch({ type: "select", id: bot.id });
    dispatch({ type: "toggleSettings", open: true, section: "voice" });
  };

  return createPortal(
    <div
      className="glass-popup-frame"
      style={glassPopupFrameStyle()}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would
          stop the pop-up's own glass from seeing the app behind it. */}
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
        data-voice-setup-dialog={bot.id}
        className="glass-surface animate-pop-in relative flex max-h-full w-[min(560px,100%)] flex-col overflow-hidden rounded-[24px] outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-7">
          <div className="flex min-w-0 items-center gap-3.5">
            <BotAvatar bot={bot} state={ready ? "happy" : "listening"} size={44} />
            <div className="min-w-0">
              <h2 id={titleId} className="truncate text-[20px] font-semibold tracking-[-0.01em] text-ink">
                {t("call.voiceSetup.title", { name: bot.name })}
              </h2>
              <p id={subtitleId} className="mt-0.5 text-[13px] text-ink-secondary">
                {t("call.voiceSetup.subtitle")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={t("call.voiceSetup.close")}
            className="shrink-0 rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={20} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 sm:px-7">
          {state.config?.tts ? (
            <VoiceSettings bot={bot} onPatch={patch} />
          ) : (
            <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-ink-secondary">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              {t("call.voiceSetup.loading")}
            </div>
          )}
        </div>

        {/* Mounted before it has anything to say, so the line is announced
            the moment the voice is ready. */}
        <div role="status" aria-live="polite">
          {ready && (
            <div className="mx-6 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-success/30 bg-success/10 px-4 py-3 sm:mx-7">
              <CheckCircle2 size={17} className="shrink-0 text-success" aria-hidden="true" />
              <span className="min-w-0 flex-1 text-[13px] font-medium text-ink">
                {t("call.voiceSetup.ready", { name: callName })}
              </span>
              <button
                type="button"
                data-voice-setup-start
                onClick={onStartCall}
                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110"
              >
                <Phone size={14} aria-hidden="true" />
                {t("call.voiceSetup.startCall")}
              </button>
            </div>
          )}
        </div>

        <footer className="flex items-center border-t border-hairline/30 px-6 py-3.5 sm:px-7">
          <button
            type="button"
            data-voice-setup-all-settings
            onClick={openAllSettings}
            className="inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-accent-text underline-offset-2 hover:underline"
          >
            {t("call.voiceSetup.allSettings")}
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
