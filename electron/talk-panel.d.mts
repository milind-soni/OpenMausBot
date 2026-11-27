export declare const TALK_PANEL: Readonly<{ width: 400; margin: 24; minHeight: 56; maxHeight: 240; fadeMs: 180 }>;
export type TalkViewState = "listening" | "sending" | "thinking" | "reply" | "needs-you" | "still-working" | "error";
export interface TalkView {
  state: TalkViewState;
  text: string;
}
export declare const TALK_LABELS: Readonly<Record<TalkViewState, string>>;
export declare function talkPanelBounds(workArea: { x: number; y: number; width: number; height: number }, height: number): { x: number; y: number; width: number; height: number };
export declare function replyPreview(text: string, limit?: number): string;
export declare function talkPanelHtml(iconBase64: string): string;
export declare function isTalkPanel(win: unknown): boolean;
export type TalkTheme = "light" | "dark";
export declare function createTalkPanel(deps: {
  BrowserWindow: new (options: Record<string, unknown>) => any;
  screen: { getCursorScreenPoint(): { x: number; y: number }; getDisplayNearestPoint(point: { x: number; y: number }): { workArea: { x: number; y: number; width: number; height: number } } };
  nativeImage: { createFromPath(path: string): { isEmpty(): boolean; resize(options: { width: number; height: number; quality?: string }): { toPNG(): Buffer } } };
  iconPath: string;
  onOpen: () => void;
  onDismiss: () => void;
  /** The app's skin as last painted; null follows macOS's appearance. */
  theme?: TalkTheme | null;
}): { render(view: TalkView): void; setTheme(theme: TalkTheme | null): void; close(): void; hovered(): boolean };
