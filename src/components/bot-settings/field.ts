import { createElement, type ReactNode } from "react";

export const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return createElement(
    "label",
    { className: "block" },
    createElement("div", { className: "mb-1.5 text-[13px] text-ink-secondary" }, label),
    children,
  );
}
