import { useState } from "react";
import { Loader2, Maximize2, Monitor } from "lucide-react";

/** A connection is only visible once the browser has decoded its first frame. */
export function CloudScreenPreview({ src, name, error, starting, opening, disabled, onOpen, onRetry }: {
  src: string | null;
  name: string;
  error: string | null;
  starting: boolean;
  opening: boolean;
  disabled: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const visible = Boolean(src && loaded === src && failed !== src);
  const problem = error ?? (src && failed === src ? "The screen image could not be displayed." : null);

  return (
    <div className="relative h-full w-full" aria-busy={!problem && (!visible || opening)}>
      {src && (
        <button
          type="button"
          onClick={onOpen}
          disabled={disabled || starting || opening || !visible}
          className="group absolute inset-0 flex h-full w-full items-center justify-center disabled:cursor-wait"
          aria-label={`Open ${name}'s live desktop`}
          title="Open live desktop"
        >
          <img
            src={src}
            alt={`${name}'s screen`}
            onLoad={() => { setLoaded(src); setFailed(null); }}
            onError={() => setFailed(src)}
            className={`h-full w-full object-contain transition group-hover:brightness-75 ${visible ? "" : "invisible"}`}
          />
          {visible && (
            <span className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white">
              {opening ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}
              {opening ? "Connecting to live desktop…" : "Open"}
            </span>
          )}
        </button>
      )}
      {!visible && !problem && (
        <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[12px] text-ink-secondary">
          <Loader2 size={18} className="animate-spin" />
          {starting ? "Starting your bot's computer…" : "Connecting to the screen…"}
        </div>
      )}
      {problem && (
        <div role="alert" className={`absolute inset-x-0 flex flex-col items-center justify-center gap-2 bg-card/95 p-4 text-center text-[12px] text-ink-secondary ${visible ? "bottom-0" : "inset-y-0"}`}>
          {!visible && <Monitor size={22} />}
          <span>{visible ? "Screen updates paused. " : "Couldn't connect to the screen. "}{problem}</span>
          <button type="button" onClick={onRetry} className="rounded-md bg-control px-3 py-1.5 text-ink hover:bg-control-hover">
            Retry preview
          </button>
        </div>
      )}
    </div>
  );
}
