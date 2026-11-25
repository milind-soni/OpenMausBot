import { win32 } from "node:path";
import { splitCliString } from "../env-path.ts";
import type { ProviderSnapshot } from "../contracts.ts";

/** Shown on an engine whose custom command starts it inside WSL: it chats, but OpenMausBot's tool servers are Windows
 * programs on Windows' loopback, which the engine inside WSL can neither start nor reach. */
export const WSL_ENGINE_WARNING = {
  title: "This engine runs inside WSL",
  message: "Its command starts it inside WSL, so it can chat but can't use OpenMausBot's tools (team, browser, computer, data and the rest). Install the engine on Windows itself and set its CLI path to that install to get them.",
} as const;

/** Whether a custom CLI command starts the engine through WSL on Windows: wsl.exe, or the bash.exe in System32 that
 * forwards to WSL (Git Bash's bash.exe is a native Windows program and is not counted). Never true off Windows. */
export function launchesThroughWsl(cli: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32" || !cli) return false;
  const head = (splitCliString(cli)[0] ?? "").toLowerCase();
  const name = win32.basename(head);
  if (name === "wsl" || name === "wsl.exe") return true;
  return /[\\/]windows[\\/](system32|sysnative)[\\/]bash(\.exe)?$/.test(head);
}

/** The status of an available engine with the WSL notice added when its command goes through WSL, unless the engine
 * reports a warning of its own. An unavailable engine keeps just its reason: it can't chat either. */
export function withWslNotice(snapshot: ProviderSnapshot, cli: string | undefined): ProviderSnapshot {
  const notice = snapshot.state === "available" && !snapshot.warning && launchesThroughWsl(cli);
  return notice ? { ...snapshot, warning: WSL_ENGINE_WARNING } : snapshot;
}
