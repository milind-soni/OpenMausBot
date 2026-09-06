import { Check, Dice5, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import {
  AVATAR_LAB_BODY_IDS,
  randomizeAvatarLabDraft,
  type AvatarLabDraft,
} from "@/lib/avatar-lab";
import {
  MAUS_COLORS,
  MAUS_COLOR_NAMES,
  PICKABLE_STATES,
  type MausColor,
  type MausMotion,
  type MausState,
} from "@/lib/mascot";
import {
  MASCOT_BODIES,
  botMascotBody,
  type MascotBodyId,
} from "../../shared/mascot-bodies";
import { MausAvatar } from "./Avatar";

export interface AvatarLabPatch {
  avatarCrop: "mascot";
  color: MausColor;
  mascotBody: MascotBodyId;
  mascotExpression: MausState;
}

export interface AvatarLabBot {
  id: string;
  name: string;
  color: MausColor;
  mascotBody?: MascotBodyId | null;
  mascotExpression?: string | null;
}

function initialDraft(bot: AvatarLabBot, activeState: MausState): AvatarLabDraft {
  const storedExpression = PICKABLE_STATES.find((state) => state === bot.mascotExpression);
  return {
    bodyId: botMascotBody(bot.mascotBody),
    color: bot.color,
    expression: storedExpression ?? activeState,
  };
}

/**
 * A single live preview plus static cards. Every surface uses MausAvatar, so
 * the list and preview cannot drift to different body, gradient, or face rigs.
 */
export function AvatarLabDialog({
  open,
  bot,
  activeState,
  mascotMotion,
  onApply,
  onClose,
}: {
  open: boolean;
  bot: AvatarLabBot;
  activeState: MausState;
  mascotMotion: { kind: Exclude<MausMotion, "none">; nonce: number } | null;
  onApply: (patch: AvatarLabPatch) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const botRef = useRef(bot);
  botRef.current = bot;
  const activeStateRef = useRef(activeState);
  activeStateRef.current = activeState;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [draft, setDraft] = useState(() => initialDraft(bot, activeState));

  useEffect(() => {
    // Runtime states can change while the dialog is open. They must not erase
    // a person's unsaved body, face, or color choices.
    if (open) setDraft(initialDraft(botRef.current, activeStateRef.current));
  }, [bot.id, open]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => dialogRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
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
      previousFocus?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-lab-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(780px,92vh)] w-full max-w-[780px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-hairline/40 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 id="avatar-lab-title" className="text-[15px] font-semibold text-ink">Avatar Lab</h2>
            <p className="mt-0.5 text-[12px] text-ink-secondary">
              One face engine, generated safe zones, and local animation previews.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Avatar Lab"
            className="flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid items-start gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
            <div className="flex self-start flex-col items-center justify-center rounded-2xl border border-hairline/40 bg-inset p-4 md:sticky md:top-4 md:min-h-[300px]">
              <MausAvatar
                key={draft.bodyId}
                color={draft.color}
                bodyId={draft.bodyId}
                state={draft.expression}
                size={152}
                motion={mascotMotion?.kind ?? "none"}
                motionKey={mascotMotion?.nonce ?? 0}
                trackPointer={false}
                label={`${bot.name} avatar preview`}
              />
              <div className="mt-3 text-center">
                <div className="text-[13px] font-medium text-ink">{bot.name}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">
                  Alerts, glyph morphs, blinking, and success confetti stay automatic in the app.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDraft((current) => randomizeAvatarLabDraft(current))}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-hairline/50 bg-control px-3 py-2.5 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <Dice5 size={16} />
                Randomize
              </button>
            </div>

            <div className="min-w-0 space-y-5">
              <section>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Body</div>
                  <div className="text-[11px] text-ink-tertiary">{AVATAR_LAB_BODY_IDS.length} generated bodies</div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {AVATAR_LAB_BODY_IDS.map((bodyId) => {
                    const selected = draft.bodyId === bodyId;
                    return (
                      <button
                        key={bodyId}
                        type="button"
                        aria-pressed={selected}
                        aria-label={`Use the ${MASCOT_BODIES[bodyId].name} body`}
                        onClick={() => setDraft((current) => ({ ...current, bodyId }))}
                        className={cn(
                          "relative flex min-w-0 flex-col items-center gap-1.5 rounded-xl border bg-inset px-2 py-2.5 hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
                          selected ? "border-accent bg-accent/10" : "border-hairline/45",
                        )}
                      >
                        <MausAvatar
                          color={draft.color}
                          bodyId={bodyId}
                          state={draft.expression}
                          size={66}
                          animated={false}
                          trackPointer={false}
                        />
                        <span className="truncate text-[11px] text-ink">{MASCOT_BODIES[bodyId].name}</span>
                        {selected ? <Check size={13} className="absolute right-2 top-2 text-accent" /> : null}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Resting face</div>
                <div className="grid grid-cols-5 gap-2">
                  {PICKABLE_STATES.map((expression) => {
                    const selected = draft.expression === expression;
                    return (
                      <button
                        key={expression}
                        type="button"
                        aria-pressed={selected}
                        aria-label={`Use ${expression} expression`}
                        title={expression}
                        onClick={() => setDraft((current) => ({ ...current, expression }))}
                        className={cn(
                          "relative flex h-[58px] items-center justify-center rounded-xl border bg-inset hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
                          selected ? "border-accent bg-accent/10" : "border-hairline/45",
                        )}
                      >
                        <MausAvatar color={draft.color} bodyId={draft.bodyId} state={expression} size={42} animated={false} trackPointer={false} />
                        {selected ? <Check size={12} className="absolute right-1.5 top-1.5 text-accent" /> : null}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Color</div>
                <div className="flex flex-wrap gap-2">
                  {MAUS_COLOR_NAMES.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Use ${color} mascot color`}
                      aria-pressed={draft.color === color}
                      onClick={() => setDraft((current) => ({ ...current, color }))}
                      className={cn(
                        "relative size-9 rounded-full border-2 border-panel shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
                        draft.color === color && "ring-2 ring-accent-border ring-offset-2 ring-offset-panel",
                      )}
                      style={{ backgroundColor: MAUS_COLORS[color] }}
                    >
                      {draft.color === color ? <Check size={14} className="absolute inset-0 m-auto text-white drop-shadow" /> : null}
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-hairline/40 px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">Cancel</button>
          <button
            type="button"
            onClick={() => {
              onApply({ avatarCrop: "mascot", color: draft.color, mascotBody: draft.bodyId, mascotExpression: draft.expression });
              onClose();
            }}
            className="min-w-[150px] rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-foreground hover:brightness-110"
          >
            Save avatar
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
