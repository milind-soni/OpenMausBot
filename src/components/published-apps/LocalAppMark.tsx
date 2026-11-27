import type { LocalApp } from "../../../shared/local-apps";
import { cn } from "@/lib/cn";
import { appInitial } from "@/lib/published-apps";
import type { Bot } from "@/state/store";

/** The app's mark: its first letter on a plate in the colour of the bot that made it, plain once that bot is gone. */
export function LocalAppMark({ app, bot, size = "md" }: { app: LocalApp; bot?: Bot; size?: "lg" | "md" | "sm" }) {
  const color = (bot ?? app.bot)?.color;
  return (
    <span aria-hidden="true" data-bot-color={color}
      className={cn("flex shrink-0 select-none items-center justify-center rounded-xl font-semibold leading-none",
        size === "lg" ? "size-16 text-[28px]" : size === "md" ? "size-11 text-[20px]" : "size-7 rounded-lg text-[13px]",
        color ? "bot-identity bg-current/[0.14]" : "bg-ink/[0.06] text-ink-tertiary")}>
      {appInitial(app.name)}
    </span>
  );
}
