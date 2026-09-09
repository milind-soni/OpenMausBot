// Shared field styling and a labeled-field wrapper for the bot settings
// dialog's sections — moved out of SettingsPanel so section files can be
// verbatim moves. Plain .ts (no JSX) so createElement is used directly;
// SoulField.tsx imports inputCls from here rather than keeping its own copy.
import { createElement, type ReactNode } from "react";

export const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return createElement(
    "label",
    { className: "block" },
    createElement("div", { className: "mb-1.5 text-[13px] text-ink-secondary" }, label),
    children,
  );
}
