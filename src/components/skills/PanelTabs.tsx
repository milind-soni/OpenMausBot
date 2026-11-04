import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

let switching = false;

/** True once, for the screen a tab switch just opened, so it appears in place instead of popping in again. */
export function takeTabSwitch(): boolean {
  const was = switching;
  switching = false;
  return was;
}

/** Apps and Skills: two tabs on one screen, in the place of its title. `titleId` names the screen's dialog. */
export function PanelTabs({ current, titleId }: { current: "apps" | "skills"; titleId: string }) {
  const { dispatch } = useStore();
  const go = (surface: "apps" | "skills") => {
    if (surface === current) return;
    switching = true;
    dispatch({ type: "togglePlugins", open: true, surface });
  };
  return (
    <div role="tablist" className="flex min-w-0 items-center gap-5">
      {(["apps", "skills"] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={tab === current ? titleId : undefined}
          data-screen-tab={tab}
          aria-selected={tab === current}
          onClick={() => go(tab)}
          className={cn(
            "min-w-0 truncate text-[20px] font-semibold leading-7 tracking-[-0.01em] transition-colors",
            tab === current ? "text-ink" : "text-ink-tertiary hover:text-ink-secondary",
          )}
        >
          {t(tab === "apps" ? "apps.title" : "skills.title")}
        </button>
      ))}
    </div>
  );
}
