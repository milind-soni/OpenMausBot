import type { ReactNode } from "react";

export { isUseMyComputerUrl } from "../../shared/use-my-computer";
/** A published page's link in a message opens like its card's Open. */
export { usePageOpener, withPageOpen } from "@/lib/page-open";

export const LINK_CLASS = "break-words text-accent underline decoration-accent/40 hover:decoration-accent [unicode-bidi:isolate]";
export const GITHUB_REF_CLASS =
  "inline-flex items-baseline gap-1 whitespace-nowrap rounded-full bg-inset px-1.5 align-baseline font-mono text-[0.88em] text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [unicode-bidi:isolate]";

/** A Use my Mac link in an older bot message, as plain text. */
export function UseMyComputerLink({ children }: { children?: ReactNode }) {
  return <span className="break-words">{children}</span>;
}
