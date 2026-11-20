import type { ReactNode } from "react";
import { useSettingsShell } from "./settings-shell";

/** A section Advanced mode adds. Search, a link or a notice that asks for it from Simple turns Advanced mode on (the
 * window does that), so it shows the moment it is asked for, and never with a note of its own. */
export function AdvancedSection({ anchor, also = [], children }: { anchor: string; also?: string[]; children: ReactNode }) {
  const { ctx, anchor: asked } = useSettingsShell();
  if (ctx.advanced) return <>{children}</>;
  if (asked !== anchor && !(asked && also.includes(asked))) return null;
  return <>{children}</>;
}
