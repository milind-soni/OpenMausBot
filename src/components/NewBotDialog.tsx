// "New bot": pick a starting point. A blank bot is one card among the
// roles; a role only pre-fills the profile (name, job, standing
// instructions) — no access is changed or connected or scheduled for you; the
// Overview checklist and /setup pick up from there.
import { useEffect, useRef, useState } from "react";
import { Bot as BotIcon, Loader2, X } from "lucide-react";

import { track } from "@/lib/analytics";
import { BOT_ROLES, type BotRole } from "@/lib/bot-roles";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

const APP_LABELS: Record<string, string> = {
  gmail: "Gmail",
  github: "GitHub",
  discord: "Discord",
  slack: "Slack",
  googlecalendar: "Calendar",
  notion: "Notion",
  linear: "Linear",
};

export function NewBotDialog() {
  const { state, dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const creating = state.botCreationPending;
  const [error, setError] = useState<string | null>(null);
  const close = () => dispatch({ type: "toggleNewBot", open: false });

  useEffect(() => {
    alive.current = true;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (dialogRef.current?.querySelector<HTMLElement>("button") ?? dialogRef.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleNewBot", open: false });
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const controls = dialog?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
      if (!controls?.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      alive.current = false;
      window.removeEventListener("keydown", onKeyDown);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [dispatch]);

  const create = (role?: BotRole) => {
    if (creating) return;
    setError(null);
    dispatch({ type: "newBot", role,
      onCreated: () => {
        track("bot_created", { role: role?.id ?? "blank" });
        if (alive.current) close();
      },
      onError: (message: string) => {
        if (!alive.current) return;
        setError(message);
      },
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={close}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={creating}
        aria-label={t("sidebar.newBot")}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-full w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-card shadow-2xl shadow-black/60"
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h2 className="text-[17px] font-semibold text-ink">{t("sidebar.newBot")}</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">{t("newBot.intro")}</p>
          </div>
          {creating && <Loader2 aria-hidden="true" size={18} className="mt-1.5 shrink-0 animate-spin text-ink-secondary" />}
          <button type="button" onClick={close} aria-label={t("common.close")} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        </div>
        {error && <p role="alert" className="px-5 pt-3 text-[13px] text-danger">{error}</p>}
        <div className="grid grid-cols-1 gap-2.5 overflow-y-auto p-5 sm:grid-cols-2">
          <button
            type="button"
            disabled={creating}
            onClick={() => create()}
            className="flex min-h-[112px] flex-col items-start gap-1.5 rounded-xl border border-dashed border-hairline/60 bg-raised/40 p-4 text-left hover:border-accent/50 hover:bg-raised disabled:opacity-50"
          >
            <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
              <BotIcon size={16} className="text-ink-secondary" /> {t("newBot.blank")}
            </span>
            <span className="text-[12.5px] leading-relaxed text-ink-secondary">{t("newBot.blankDescription")}</span>
          </button>
          {BOT_ROLES.map((role) => (
            <button
              key={role.id}
              type="button"
              disabled={creating}
              onClick={() => create(role)}
              className={cn(
                "flex min-h-[112px] flex-col items-start gap-1.5 rounded-xl border border-hairline/50 bg-raised/40 p-4 text-left",
                "hover:border-accent/50 hover:bg-raised disabled:opacity-50",
              )}
            >
              <span className="text-[14px] font-medium text-ink">{role.title}</span>
              <span className="text-[12.5px] leading-relaxed text-ink-secondary">{role.description}</span>
              {role.apps.length > 0 && (
                <span className="mt-auto flex flex-wrap gap-1 pt-1">
                  {role.apps.map((slug) => (
                    <span key={slug} className="rounded-full bg-inset px-2 py-0.5 text-[11px] text-ink-secondary">
                      {APP_LABELS[slug] ?? slug}
                    </span>
                  ))}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
