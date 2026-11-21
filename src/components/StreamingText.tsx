import { useLayoutEffect, useRef } from "react";
import { reducedMotion } from "@/lib/onboarding";

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

export function streamWords(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), part => part.segment) : text.match(/\s+|\S+/g) ?? [];
}

export function useStreamingFade<T extends HTMLElement>(active: boolean) {
  const root = useRef<T>(null);
  const seen = useRef(new WeakMap<Element, string>());
  const lastStart = useRef(0);
  useLayoutEffect(() => {
    if (!active || !root.current) return;
    const animated = !reducedMotion();
    const fresh: HTMLElement[] = [];
    for (const word of root.current.querySelectorAll<HTMLElement>(".chat-stream-word")) {
      const text = word.textContent;
      const previous = seen.current.get(word);
      if (previous === undefined || !text.startsWith(previous)) fresh.push(word);
      seen.current.set(word, text);
    }
    if (!animated || !fresh.length) return;
    const now = performance.now();
    const start = Math.max(now, lastStart.current);
    const interval = Math.min(16, Math.max(0, now + 96 - start) / Math.max(1, fresh.length - 1));
    fresh.forEach((word, index) => word.animate?.(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 180, delay: start - now + index * interval, easing: "ease-out", fill: "backwards" },
    ));
    lastStart.current = start + (fresh.length - 1) * interval;
  });
  return root;
}

export function StreamingText({ text }: { text: string }) {
  const root = useStreamingFade<HTMLSpanElement>(true);
  return <span ref={root}>{streamWords(text).map((word, index) =>
    /\S/u.test(word) ? <span key={index} className="chat-stream-word">{word}</span> : word,
  )}</span>;
}
