import type { CSSProperties, ReactNode, Ref } from "react";
import { ArrowLeft } from "lucide-react";

import { useDesktopCapabilities, windowFramed } from "@/components/DesktopCapabilities";
import { cn } from "@/lib/cn";

// The page a Tools entry opens in place of the chat (Automations and its calendar, Published apps): one header with
// Back, the title and the page's own controls, over the page's body.

export const TOOL_PAGE_TITLE = "mr-1 text-[18px] font-semibold tracking-tight text-ink";

// SAFETY: Electron's -webkit-app-region is not in React's CSSProperties type; the renderer accepts it as an inline style.
const DRAG = { WebkitAppRegion: "drag" } as CSSProperties, NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

function useMacInset(): boolean {
  return useDesktopCapabilities().capabilities.windowChrome === "mac-inset";
}

export function ToolPage({ label, children }: { label?: string; children: ReactNode }) {
  return <main aria-label={label} className="flex h-full min-w-0 flex-1 flex-col bg-app animate-workspace-in">{children}</main>;
}

/** `besideSidebar` is false while the page has the whole window (the calendar), so the title clears the Mac window
 * buttons instead of the phone's drawer button. */
export function ToolPageHeader({ backLabel, onBack, backRef, besideSidebar = true, children }: {
  backLabel: string;
  onBack: () => void;
  backRef?: Ref<HTMLButtonElement>;
  besideSidebar?: boolean;
  children: ReactNode;
}) {
  const { capabilities } = useDesktopCapabilities();
  const macInset = useMacInset();
  return (
    <header className={cn("shrink-0 border-b border-hairline/35 bg-app py-3 pr-4", macInset && !windowFramed(capabilities) && !besideSidebar ? "pl-[86px]" : besideSidebar ? "pl-12 md:pl-4" : "pl-4")} style={macInset ? DRAG : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" ref={backRef} onClick={onBack} aria-label={backLabel} title={backLabel} className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink" style={macInset ? NO_DRAG : undefined}><ArrowLeft size={18} /></button>
        {children}
      </div>
    </header>
  );
}

export function ToolPageActions({ children }: { children: ReactNode }) {
  return <div className="ml-auto flex items-center gap-3" style={useMacInset() ? NO_DRAG : undefined}>{children}</div>;
}
