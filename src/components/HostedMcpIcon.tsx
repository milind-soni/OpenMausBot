import type { HostedMcpApp } from "@/lib/hosted-mcp-apps";

/** The app's 40 px tile: its logo, or its glyph on a neutral tile. */
export function HostedMcpIcon({ app }: { app: HostedMcpApp }) {
  if ("image" in app.icon) return <img src={app.icon.image} alt="" className="size-10 shrink-0 rounded-xl object-contain" />;
  const Glyph = app.icon.glyph;
  return <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised text-ink-secondary"><Glyph size={19} aria-hidden="true" /></span>;
}
