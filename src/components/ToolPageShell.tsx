import type { CSSProperties, ReactNode, Ref } from "react";
import { ArrowLeft } from "lucide-react";

import { useDesktopCapabilities } from "@/components/DesktopCapabilities";

// The page a Tools entry opens in place of the chat (Automations and its calendar, Published apps): one header with
// Back, the title and the page's own controls, over the page's body.

export const TOOL_PAGE_TITLE = "mr-1 text-[18px] font-semibold tracking-tight text-ink";

// SAFETY: Electron's -webkit-app-region is not in React's CSSProperties type; the renderer accepts it as an inline style.
const DRAG = { WebkitAppRegion: "drag" } as CSSProperties, NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

function useMacInset(): boolean {
  return useDesktopCapabilities().capabilities.windowChrome === "mac-inset";
}

export function ToolPage({ label, fade = false, children }: { label?: string; fade?: boolean; children: ReactNode }) {
  return <main aria-label={label} className={`flex h-full min-w-0 flex-1 flex-col bg-app ${fade ? "motion-safe:animate-fade-in" : "animate-workspace-in"}`}>{children}</main>;
}

export function ToolPageHeader({ backLabel, onBack, backRef, children }: {
  backLabel: string;
  onBack: () => void;
  backRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  const macInset = useMacInset();
  return (
    <header className="shrink-0 border-b border-hairline/35 bg-app py-3 pr-4 pl-12 md:pl-4" style={macInset ? DRAG : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" ref={backRef} onClick={onBack} aria-label={backLabel} title={backLabel} className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary interaction:bg-raised/50 hover:text-ink" style={macInset ? NO_DRAG : undefined}><ArrowLeft size={18} /></button>
        {children}
      </div>
    </header>
  );
}

export function ToolPageActions({ children }: { children: ReactNode }) {
  return <div className="ml-auto flex items-center gap-3" style={useMacInset() ? NO_DRAG : undefined}>{children}</div>;
}
