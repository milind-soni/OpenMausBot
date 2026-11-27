import { cn } from "@/lib/cn";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject, type TextareaHTMLAttributes } from "react";
import { type MentionPeer } from "@/lib/mentions";
import { MentionText } from "./MentionText";

const TEXT_LAYOUT = ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-feature-settings", "font-variation-settings",
  "letter-spacing", "word-spacing", "line-height", "text-indent", "tab-size", "padding-top", "padding-right", "padding-bottom", "padding-left"] as const;

export function MentionTextarea({ inputRef, peers, everyone = false, wrapperClassName, ghost, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  wrapperClassName?: string;
  /** Drawn over the empty field in its own text layout, in place of the placeholder. */
  ghost?: ReactNode;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  peers: readonly MentionPeer[];
  everyone?: boolean;
}) {
  const [composing, setComposing] = useState(false);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const sync = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const style = getComputedStyle(input);
    for (const layer of [mirrorRef.current, ghostRef.current]) {
      if (!layer) continue;
      for (const property of TEXT_LAYOUT) layer.style.setProperty(property, style.getPropertyValue(property));
      layer.style.width = `${input.clientWidth}px`;
    }
    const mirror = mirrorRef.current;
    if (!mirror) return;
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
  }, [inputRef]);
  const resize = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const scrollTop = input.scrollTop;
    const line = parseFloat(getComputedStyle(input).lineHeight) || 24;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, line * 6)}px`;
    input.scrollTop = scrollTop;
    sync();
  }, [inputRef, sync]);
  useLayoutEffect(resize, [props.value, props.className, resize]);
  const ghostShown = Boolean(ghost);
  useLayoutEffect(sync, [ghostShown, sync]);
  useLayoutEffect(() => {
    let width = inputRef.current?.clientWidth;
    const observer = new ResizeObserver(() => {
      // Observe width only, so setting the measured height cannot create a resize loop.
      const nextWidth = inputRef.current?.clientWidth;
      if (nextWidth !== width) { width = nextWidth; resize(); }
      else sync();
    });
    if (inputRef.current) observer.observe(inputRef.current);
    return () => observer.disconnect();
  }, [inputRef, resize, sync]);
  return <div data-composing={composing || undefined} data-ghost={ghostShown ? "" : undefined} className={cn("mention-editor relative min-w-0 flex-1 self-center", wrapperClassName)}>
    <div ref={mirrorRef} dir={props.dir} aria-hidden="true" className="mention-editor-mirror pointer-events-none absolute inset-0 overflow-hidden">
      <MentionText text={String(props.value ?? "")} peers={peers} everyone={everyone} />{"\n"}
    </div>
    {ghostShown ? <div ref={ghostRef} dir={props.dir} className="mention-editor-ghost pointer-events-none absolute inset-0 overflow-hidden">{ghost}</div> : null}
    <textarea {...props} ref={inputRef}
      onCompositionStart={(event) => { setComposing(true); props.onCompositionStart?.(event); }}
      onCompositionEnd={(event) => { setComposing(false); props.onCompositionEnd?.(event); }}
      onBlur={(event) => { setComposing(false); props.onBlur?.(event); }}
      onScroll={(event) => { sync(); props.onScroll?.(event); }} />
  </div>;
}
