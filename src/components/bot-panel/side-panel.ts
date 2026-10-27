import { cn } from "@/lib/cn";

export const sidePanelCls = (overlay: boolean) => cn(
  "animate-sheet-in md:animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel outline-none focus-visible:outline-none",
  overlay
    ? "md:inset-auto md:right-0 md:top-0 md:bottom-0 md:w-[min(420px,42vw)] md:shadow-2xl"
    : "md:static md:z-auto md:w-[min(420px,42vw)] md:shrink-0",
);
