export interface DesktopNotificationNote {
  title: string;
  body: string;
  tag?: string;
  silent?: boolean;
  /** The bot's picture, on the page's own origin. */
  picture?: string;
  botId: string;
  threadId: string;
}

export interface DesktopNotificationsBridge {
  /** Resolves false when main shows nothing (no system support, or not this window's page): the page shows its own. */
  show(note: DesktopNotificationNote): Promise<boolean>;
  /** A click on one of them brought this page up: open that thread. */
  onOpen(cb: (target: { botId: string; threadId: string }) => void): () => void;
}
