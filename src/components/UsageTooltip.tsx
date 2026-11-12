export function UsageTooltip({ id, text }: { id: string; text: string }) {
  return <span id={id} role="tooltip" className="pointer-events-none absolute right-0 top-full z-40 mt-1.5 w-max max-w-[min(300px,calc(100vw-24px))] rounded-lg border border-hairline/50 bg-card px-2.5 py-1.5 text-left text-[11.5px] leading-4 text-ink shadow-xl">{text}</span>;
}
