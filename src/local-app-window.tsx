// A saved app in a window of its own (/local-app?id=…): only the app and its slim header, without the chat app's store,
// stream or sidebar. The frame is the same one the chat mounts.
import { useEffect, useMemo } from "react";
import { LocalAppView } from "@/components/published-apps/LocalAppView";
import { productName } from "@/lib/brand";
import { useLocalApps } from "@/lib/local-apps";
import { BotEditorStore, initialState, type useStore } from "@/state/store";

/** "Go to chat" from here brings the main window to the app's conversation. */
function chatLink(threadId: string, botId: string): string {
  return `openmausbot://thread/${encodeURIComponent(threadId)}?bot=${encodeURIComponent(botId)}`;
}

export function LocalAppWindow({ id }: { id: string }) {
  const value = useMemo(() => ({
    state: initialState, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
  }) as unknown as ReturnType<typeof useStore>, []);
  const { apps } = useLocalApps();
  const name = apps?.find((app) => app.id === id)?.name;
  useEffect(() => { document.title = name ? `${name} · ${productName()}` : productName(); }, [name]);
  const openChat = window.ogb?.localApps?.openChat;
  return (
    <BotEditorStore value={value}>
      <div data-local-app-window={id} className="flex h-dvh min-h-0 flex-col bg-app">
        <LocalAppView id={id}
          onGoToChat={(app) => (openChat && app.chat ? () => void openChat(chatLink(app.threadId, app.botId)).catch(() => undefined) : undefined)} />
      </div>
    </BotEditorStore>
  );
}
