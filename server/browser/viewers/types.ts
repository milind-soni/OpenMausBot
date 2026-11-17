import type { InstalledExtension } from "../extensions.ts";
import type { SelectPopup } from "./popups.ts";
import type { ViewportSetting } from "./viewport.ts";

/** Chromium keeps three frames unacknowledged, so acking 100 ms after arrival caps a viewer near 30 fps. */
export const ACK_PACE_MS = { hi: 100, lo: 200 } as const;

export interface FrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  offsetTop: number;
  pageScaleFactor: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp?: number;
}

export type Controller = "agent" | "you" | "another-viewer" | "unclaimed";

export type ViewerOutput =
  | { type: "nativeView"; token: string | null }
  | { type: "frame"; data: Buffer; metadata: FrameMetadata; still: boolean; ack: () => void }
  | { type: "viewport"; width: number; height: number; setting: ViewportSetting; zoom: number }
  | { type: "control"; canOperate: boolean; controller: Controller; held: boolean; owned: boolean; controlling: boolean; stale: boolean; generation: number; dialog: { type: string; message: string; defaultValue: string } | null }
  | { type: "tabs"; tabs: Array<{ tabId: string; title: string; url: string; active: boolean }> }
  | { type: "url"; url: string }
  | { type: "nav"; tabId: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
  | { type: "status"; connected: boolean; screencasting: boolean; viewportWidth: number; viewportHeight: number }
  | { type: "clipboard"; text: string } | { type: "extensions"; extensions: InstalledExtension[] }
  | { type: "probe"; x: number; y: number; editable: boolean }
  | { type: "pointer"; phase: "move" | "click"; x: number; y: number; sequence: number }
  | { type: "fileChooser"; id: string; multiple: boolean; accept: string }
  | { type: "fileChooserClosed"; id: string }
  | { type: "download"; id: string; fileName: string; sizeBytes: number }
  | { type: "popup"; tabId: string }
  | ({ type: "selectPopup"; id: string } & SelectPopup)
  | { type: "cursor"; shape: string }
  | { type: "authPrompt"; tabId: string; id: string; origin: string; realm: string }
  | { type: "authPromptClosed"; id: string }
  | { type: "starting" }
  /** The browser closed unused and the view stays; "awake" when it starts again. */
  | { type: "asleep" | "awake" }
  | { type: "gone"; reason: string };

export interface ViewerOptions {
  nativeView?: boolean;
  /** The session watching, or local-owner. */
  owner: string;
  /** Whose hold this view shares, on any device: their account's key, the owner when unset. */
  person?: string;
  canOperate: boolean;
  /** The largest frame this viewer can use, in device pixels. */
  maxWidth: number;
  maxHeight: number;
  quality?: number;
  pace?: keyof typeof ACK_PACE_MS;
  /** The panel's size in CSS pixels, which the page fills. */
  size?: { width: number; height: number } | null;
  /** The viewer can show a site's HTTP sign-in prompt to its person; the v1 view cannot. */
  authPrompts?: boolean;
  /** The viewer draws a page's dropdown lists and its cursor shape; the v1 view cannot, so its presses reach the page. */
  pagePopups?: boolean;
  /** The viewer draws the agent's pointer, which the agent's actions wait for; false for the v1 view, which draws none. */
  pointer?: boolean;
}
