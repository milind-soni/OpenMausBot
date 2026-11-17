import { Bot, Hand, Play, Square, X } from "lucide-react";
import type { PreviewTestingSession } from "@/lib/previewTesting";
import { testingStore } from "@/lib/previewTestingStore";
import { cn } from "@/lib/cn";

/**
 * Bot testing tabs and the control bar, shared by Quick Preview and the
 * full-screen Preview page.
 */
export function PreviewBotBar({ botTabs, botTab, attached, controlSession, error, className }: {
  botTabs: PreviewTestingSession[];
  botTab: PreviewTestingSession | null;
  attached: PreviewTestingSession | null;
  controlSession: PreviewTestingSession | null;
  error: string;
  className?: string;
}) {
  return (
    <>
      {(botTabs.length > 0 || attached) && (
        <div role="tablist" aria-label="Preview tabs" className={cn("flex shrink-0 gap-1 overflow-x-auto border-b border-hairline/40 px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
          <button
            type="button"
            role="tab"
            aria-selected={!botTab}
            onClick={() => testingStore.setTab(null)}
            className={cn("flex max-w-[180px] shrink-0 items-center gap-1.5 truncate rounded-md px-2.5 py-1 text-[11.5px]", !botTab ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised")}
          >
            {attached && <Bot className="h-3 w-3 shrink-0" aria-label={`${attached.botName} is on this page`} />}
            <span className="truncate">Your page</span>
          </button>
          {botTabs.map((s) => (
            <div key={s.id} className={cn("flex max-w-[220px] shrink-0 items-center rounded-md text-[11.5px]", s.id === botTab?.id ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised")}>
              <button type="button" role="tab" aria-selected={s.id === botTab?.id} onClick={() => testingStore.setTab(s.id)} className="flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-1" title={`${s.botName} · ${s.name}`}>
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.state === "paused" ? "bg-ink-secondary" : s.state === "error" ? "bg-danger" : "animate-pulse bg-accent")} />
                <span className="truncate">{s.botName} · {s.name}</span>
              </button>
              <button type="button" aria-label={`End ${s.botName}'s test`} title="End this test" onClick={() => void testingStore.control(s.id, "close")} className="rounded p-1 hover:text-ink">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {controlSession && (
        <div className={cn("flex shrink-0 items-center gap-2 border-b border-hairline/40 bg-accent/5 px-3 py-1.5 text-[11.5px]", className)}>
          {controlSession.state === "paused" ? <Hand className="h-3.5 w-3.5 shrink-0 text-ink-secondary" /> : <Bot className="h-3.5 w-3.5 shrink-0 text-accent" />}
          <span role="status" className="min-w-0 flex-1 truncate text-ink-secondary">
            {controlSession.state === "error"
              ? controlSession.error ?? "This test needs attention"
              : controlSession.state === "paused"
                ? controlSession.canResume
                  ? "You have control"
                  : `Page replaced · ask ${controlSession.botName} to start a new test`
                : <><span className="font-medium text-ink">{controlSession.botName}</span> {botTab ? "is in control" : "is in control of your page"} · {controlSession.activity}</>}
          </span>
          {controlSession.state === "paused"
            ? controlSession.canResume && (
                <button type="button" onClick={() => void testingStore.control(controlSession.id, "resume")} className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] text-white">
                  <Play className="h-3 w-3" />Resume bot
                </button>
              )
            : controlSession.state !== "error" && (
                <button type="button" onClick={() => void testingStore.control(controlSession.id, "pause")} className="flex shrink-0 items-center gap-1 rounded-md border border-hairline/60 bg-raised px-2 py-1 text-[11px] text-ink">
                  <Square className="h-2.5 w-2.5" />Stop / take control
                </button>
              )}
          {!botTab && (
            <button type="button" aria-label={`End ${controlSession.botName}'s test`} title="End this test" onClick={() => void testingStore.control(controlSession.id, "close")} className="shrink-0 rounded p-1 text-ink-secondary hover:text-ink">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      {error && (botTab || attached) && (
        <div role="alert" className={cn("border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11.5px] text-danger", className)}>{error}</div>
      )}
    </>
  );
}
