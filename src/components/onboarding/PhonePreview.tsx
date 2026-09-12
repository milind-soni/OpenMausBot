// A drawn phone showing what pairing gives you: the same chat on a small
// screen, with an approval card you can answer from the sofa. Used by the
// welcome tour's phone beat in place of three identical value cards. Purely
// illustrative: nothing here is interactive.
import { Check, X } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { brand } from "@/lib/brand";

export function PhonePreview({ className }: { className?: string }) {
  return (
    <div className={cn("relative", className)} aria-hidden="true">
      <div className="absolute inset-x-6 bottom-2 top-6 rounded-[40px] bg-accent/20 blur-2xl" />
      <div className="relative mx-auto w-[168px] rounded-[30px] border border-hairline/60 bg-panel p-[6px] shadow-[0_28px_60px_-24px_rgba(0,0,0,0.6),0_1px_0_rgba(255,255,255,0.06)_inset]">
        <div className="overflow-hidden rounded-[24px] bg-app">
          {/* status bar and notch */}
          <div className="relative flex h-7 items-center justify-between px-4 text-[8px] font-medium tabular-nums text-ink">
            <span>9:41</span>
            <span className="absolute left-1/2 top-1.5 h-3.5 w-12 -translate-x-1/2 rounded-full bg-panel" />
            <span className="flex items-center gap-0.5">
              <span className="h-1.5 w-2.5 rounded-[2px] border border-ink/70" />
            </span>
          </div>
          {/* chat header */}
          <div className="flex items-center gap-1.5 border-b border-hairline/40 px-3 py-1.5">
            <MausAvatar color="green" state="happy" size={16} animated={false} trackPointer={false} />
            <span className="text-[9.5px] font-semibold text-ink">Maus</span>
            <span className="ml-auto size-1.5 rounded-full bg-success" />
          </div>
          {/* transcript */}
          <div className="flex flex-col gap-1.5 px-2.5 py-2.5">
            <div className="max-w-[112px] self-end rounded-xl rounded-br-sm bg-bubble-user px-2 py-1.5 text-[8.5px] leading-snug text-ink">
              Book the 3 pm slot
            </div>
            <div className="max-w-[124px] rounded-xl rounded-tl-sm bg-card px-2 py-1.5 text-[8.5px] leading-snug text-ink">
              Found it. Confirm the booking?
            </div>
            <div className="rounded-lg border border-hairline/50 bg-card p-2">
              <div className="text-[8px] font-medium text-ink">Run: book-slot</div>
              <div className="mt-0.5 text-[7.5px] text-ink-secondary">clinic.example · 3:00 pm</div>
              <div className="mt-1.5 flex gap-1">
                <span className="flex flex-1 items-center justify-center gap-0.5 rounded-md bg-accent py-1 text-[8px] font-semibold text-white">
                  <Check size={8} strokeWidth={3} /> Allow
                </span>
                <span className="flex flex-1 items-center justify-center gap-0.5 rounded-md bg-raised py-1 text-[8px] font-medium text-ink">
                  <X size={8} strokeWidth={3} /> Deny
                </span>
              </div>
            </div>
          </div>
          {/* composer */}
          <div className="mx-2.5 mb-2.5 rounded-full border border-hairline/40 bg-inset px-2.5 py-1.5 text-[8px] text-ink-secondary">
            Message {brand().name === "OpenMausBot" ? "Maus" : brand().name}
          </div>
        </div>
      </div>
    </div>
  );
}
