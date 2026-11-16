import type { MessageAttachmentContext } from "@/components/AttachmentPreview";
import type { AppState } from "@/state/store";
import { browserAvailable, builtInBrowserEnabled } from "./feature-flags";
import { t } from "./i18n";

type Facts = {
  selectedId: AppState["selectedId"];
  config: AppState["config"];
  bots: Array<Pick<AppState["bots"][number], "id" | "browser" | "computer" | "browserProfile">>;
};

export function nativeArtifactAvailable(state: Facts | null, capabilities: Pick<DesktopCapabilities, "nativeBrowser">): boolean {
  if (!state || capabilities.nativeBrowser?.available !== true || !builtInBrowserEnabled(state.config)) return false;
  const engine = state.config?.browserEngine;
  if (engine?.engine !== "native" || !browserAvailable(state.config) || engine.installing || engine.installError) return false;
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
  if (!bot || bot.browser === false || bot.computer === "off") return false;
  const profile = state.config?.browserProfiles?.find((candidate) => candidate.id === bot.browserProfile);
  return profile?.browser !== "chrome";
}

export async function requestNativeArtifact(path: string, message: MessageAttachmentContext, signal?: AbortSignal): Promise<string> {
  const route = `/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file`;
  const response = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, openNativeBrowser: true }),
    signal,
  });
  const result = await response.json().catch(() => null) as { nativeBrowserOpened?: unknown; botId?: unknown; error?: unknown } | null;
  if (!response.ok || result?.nativeBrowserOpened !== true || typeof result.botId !== "string" || !result.botId) {
    throw new Error(typeof result?.error === "string" && result.error ? result.error : t("html.openFailed"));
  }
  return result.botId;
}
