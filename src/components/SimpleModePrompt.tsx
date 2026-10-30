import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { readAdvancedMode, setAdvancedMode, useAdvancedMode } from "@/lib/interface-mode";
import { markSimpleModePromptSeen } from "@/lib/simple-mode-prompt";

export const SIMPLE_MODE_PROMPT = "[data-simple-mode-prompt]";
const TITLE = "simple-mode-prompt-title";

export function reportSimpleModePrompt(action: "shown" | "toggled" | "closed", advanced = readAdvancedMode()): void {
  track("simple_mode_prompt", { action, mode: advanced ? "advanced" : "simple" });
}

/** Once per browser (AppNotices): a switch for Simple mode that changes the app behind it as it is flipped. Done, ×,
 * Escape and a click outside close it for good. The mode stays in Settings → General. */
export function SimpleModePrompt({ onClose }: { onClose: () => void }) {
  const advanced = useAdvancedMode();
  const simple = !advanced;
  // Its words stay those it opened with; the switch follows the mode, here or from another tab.
  const [openedSimple] = useState(simple);
  const close = () => {
    reportSimpleModePrompt("closed", advanced);
    markSimpleModePromptSeen();
    onClose();
  };
  const flip = () => {
    setAdvancedMode(simple);
    reportSimpleModePrompt("toggled", simple);
  };

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    document.getElementById(TITLE)?.focus();
    return () => {
      if (opener?.isConnected && opener !== document.body) opener.focus();
    };
  }, []);
  // Focus stays inside while it is open; Escape closes it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = document.querySelector<HTMLElement>(SIMPLE_MODE_PROMPT);
      if (!root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>("button:not([disabled])")];
      if (!controls.length) return;
      event.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLElement), step = event.shiftKey ? -1 : 1;
      controls[at === -1 ? (step > 0 ? 0 : controls.length - 1) : (at + step + controls.length) % controls.length]!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="ui-scrim ui-scrim-light fixed inset-0 z-50 flex items-center justify-center p-4 motion-reduce:animate-none"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={TITLE} aria-describedby="simple-mode-prompt-body" data-simple-mode-prompt=""
        className="ui-modal animate-pop-in relative w-[min(440px,calc(100vw-32px))] rounded-[16px] border-0 px-6 pb-5 pt-6 text-ink motion-reduce:animate-none">
        {/* Focus lands on the title, which is no control: it shows no ring. */}
        <h2 id={TITLE} tabIndex={-1} className="pe-8 text-[17px] font-medium leading-6 tracking-[-0.008em] outline-none!">
          {t(openedSimple ? "simpleModePrompt.titleOn" : "simpleModePrompt.title")}
        </h2>
        <p id="simple-mode-prompt-body" className="mt-2 text-[14px] leading-5 text-ink-secondary">{t("simpleModePrompt.body")}</p>
        <button
          type="button"
          role="switch"
          aria-checked={simple}
          aria-labelledby="simple-mode-switch-label"
          aria-describedby="simple-mode-switch-hint"
          data-simple-mode-switch=""
          onClick={flip}
          className="mt-5 flex min-h-14 w-full items-center gap-4 rounded-[12px] bg-ink/[0.04] px-4 py-3 text-left transition-colors hover:bg-ink/[0.07] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none"
        >
          <span className="min-w-0 flex-1">
            <span id="simple-mode-switch-label" className="block text-[15px] font-medium leading-5">{t("simpleModePrompt.switch")}</span>
            <span id="simple-mode-switch-hint" className="mt-0.5 block text-[13px] leading-[18px] text-ink-secondary">{t("simpleModePrompt.switchHint")}</span>
          </span>
          <span aria-hidden="true" className={cn("relative h-7 w-12 shrink-0 rounded-full transition-colors motion-reduce:transition-none",
            simple ? "bg-accent" : "bg-ink/[0.14] ring-1 ring-inset ring-ink/40")}>
            <span className={cn("absolute top-0.5 size-6 rounded-full bg-white shadow-sm transition-[left] motion-reduce:transition-none",
              simple ? "left-[22px]" : "left-0.5")} />
          </span>
        </button>
        <p className="mt-3 text-[13px] leading-[18px] text-ink-tertiary">{t("simpleModePrompt.where")}</p>
        <div className="mt-5 flex justify-end">
          <button type="button" data-primary="" onClick={close}
            className="ui-button ui-button-pill min-w-[88px] border-transparent bg-ink text-app hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
            {t("common.done")}
          </button>
        </div>
        <button type="button" onClick={close} aria-label={t("common.close")} className="ui-icon-button absolute end-3 top-3"><X size={16} /></button>
      </div>
    </div>
  );
}
