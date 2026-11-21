import { cn } from "@/lib/cn";
import { useCallback, useLayoutEffect, useRef, type RefObject, type TextareaHTMLAttributes } from "react";
import { mentionRanges, type MentionPeer } from "@/lib/mentions";
import { MentionText } from "./MentionText";

const TEXT_LAYOUT = ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-feature-settings", "font-variation-settings",
  "letter-spacing", "word-spacing", "line-height", "text-indent", "tab-size", "padding-top", "padding-right", "padding-bottom", "padding-left"] as const;

export function MentionTextarea({ inputRef, peers, everyone = false, wrapperClassName, singleLinePlaceholder, smoothHeight = false, onOpenBot, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  wrapperClassName?: string;
  singleLinePlaceholder?: boolean;
  smoothHeight?: boolean;
  onOpenBot?: (botId: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  peers: readonly MentionPeer[];
  everyone?: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const hoveredMention = useRef<HTMLElement | null>(null);
  const highlightMention = (mention: HTMLElement | null) => {
    if (hoveredMention.current === mention) return;
    hoveredMention.current?.removeAttribute("data-hovered");
    mention?.setAttribute("data-hovered", "");
    hoveredMention.current = mention;
  };
  const sync = useCallback(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    const style = getComputedStyle(input);
    for (const property of TEXT_LAYOUT) mirror.style.setProperty(property, style.getPropertyValue(property));
    mirror.style.width = `${input.clientWidth}px`;
    if (smoothHeight) mirror.style.height = `${input.clientHeight}px`;
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
  }, [inputRef, smoothHeight]);
  const resize = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const scrollTop = input.scrollTop;
    const line = parseFloat(getComputedStyle(input).lineHeight) || 24;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, line * 6)}px`;
    if (smoothHeight && wrapperRef.current) wrapperRef.current.style.height = `${input.offsetHeight}px`;
    input.scrollTop = scrollTop;
    sync();
  }, [inputRef, smoothHeight, sync]);
  useLayoutEffect(resize, [props.value, props.className, resize]);
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
  const value = String(props.value ?? "");
  const tokens = mentionRanges(value, peers, everyone).filter(range => range.bot);
  const snap = (input: HTMLTextAreaElement) => {
    const { selectionStart: start, selectionEnd: end, selectionDirection } = input;
    const from = tokens.find(token => token.start < start && start < token.end);
    const to = tokens.find(token => token.start < end && end < token.end);
    if (!from && !to) return;
    if (start === end && from) {
      const edge = start - from.start < from.end - start ? from.start : from.end;
      input.setSelectionRange(edge, edge);
    } else input.setSelectionRange(from?.start ?? start, to?.end ?? end, selectionDirection);
  };
  const mentionAt = (clientX: number, clientY: number) => {
    const mentions = mirrorRef.current?.querySelectorAll<HTMLElement>("[data-bot-mention]") ?? [];
    return Array.from(mentions).find(mention => Array.from(mention.getClientRects()).some(rect =>
      clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom));
  };
  return <div ref={wrapperRef} className={cn("mention-editor relative min-w-0 flex-1 self-center", wrapperClassName, smoothHeight && "v2-composer-field")}
    data-mention-navigation={onOpenBot ? "" : undefined}
    onMouseMove={({ clientX, clientY, target }) => {
      highlightMention(target === inputRef.current ? mentionAt(clientX, clientY) ?? null : null);
    }}
    onMouseLeave={() => highlightMention(null)}>
    <div ref={mirrorRef} dir={props.dir} aria-hidden="true" className="mention-editor-mirror pointer-events-none absolute inset-0 overflow-hidden">
      <MentionText text={value} peers={peers} everyone={everyone} mirror />{"\n"}
    </div>
    {singleLinePlaceholder && !props.value && props.placeholder && (
      <span dir={props.dir} aria-hidden="true" className="pointer-events-none absolute inset-x-1 top-1 truncate text-[14px] leading-6 text-ink-tertiary">
        {props.placeholder}
      </span>
    )}
    <textarea {...props} className={cn(props.className, singleLinePlaceholder && "placeholder:whitespace-nowrap placeholder:text-transparent")} ref={inputRef}
      onSelect={event => { snap(event.currentTarget); props.onSelect?.(event); }}
      onClick={event => {
        const input = event.currentTarget;
        if (onOpenBot && event.detail === 1 && input.selectionStart === input.selectionEnd) {
          const botId = mentionAt(event.clientX, event.clientY)?.dataset.mentionBotId;
          if (botId) { onOpenBot(botId); return; }
        }
        snap(input);
        props.onClick?.(event);
      }}
      onKeyDown={event => {
        props.onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        const input = event.currentTarget;
        if (input.selectionStart !== input.selectionEnd || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        const forward = (event.key === "ArrowRight") !== (getComputedStyle(input).direction === "rtl");
        const caret = input.selectionStart;
        const token = tokens.find(range => (forward ? range.start : range.end) === caret);
        if (!token) return;
        event.preventDefault();
        const edge = forward ? token.end : token.start;
        input.setSelectionRange(event.shiftKey ? token.start : edge, event.shiftKey ? token.end : edge, forward ? "forward" : "backward");
      }}
      onChange={event => {
        const input = event.currentTarget;
        const next = input.value;
        if (tokens.length && !(event.nativeEvent as InputEvent).isComposing) {
          let start = 0;
          while (start < value.length && start < next.length && value[start] === next[start]) start += 1;
          let end = value.length, nextEnd = next.length;
          while (end > start && nextEnd > start && value[end - 1] === next[nextEnd - 1]) { end -= 1; nextEnd -= 1; }
          const from = tokens.find(token => token.start < start && start < token.end);
          const to = tokens.find(token => token.start < end && end < token.end);
          if (from || to) {
            const inserted = next.slice(start, nextEnd);
            const insertionStart = from?.start ?? start;
            input.value = value.slice(0, insertionStart) + inserted + value.slice(to?.end ?? end);
            const caret = insertionStart + inserted.length;
            input.setSelectionRange(caret, caret);
          }
        }
        props.onChange?.(event);
      }}
      onScroll={(event) => { highlightMention(null); sync(); props.onScroll?.(event); }} />
  </div>;
}
