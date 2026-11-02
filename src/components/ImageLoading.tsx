import { LoaderCircle } from "lucide-react";
import { useRef } from "react";

import { cn } from "@/lib/cn";
import { useOnScreen } from "@/lib/on-screen";

export function ImageLoading({ name, className }: { name: string; className: string }) {
  const tile = useRef<HTMLSpanElement>(null);
  const moving = useOnScreen(tile);
  return (
    <span ref={tile} className={cn("flex items-center justify-center", moving && "animate-pulse", className)} role="status">
      <LoaderCircle size={17} className={cn("text-ink-tertiary", moving && "animate-spin")} />
      <span className="sr-only">Loading {name}</span>
    </span>
  );
}
