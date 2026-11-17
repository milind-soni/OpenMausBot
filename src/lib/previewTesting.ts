import type { PreviewSource } from "./mobilePreviewUrl";
export interface PreviewTestingSession {
  id: string;
  botId: string;
  botName: string;
  name: string;
  url: string;
  source: PreviewSource;
  width: number;
  height: number;
  responsive: boolean;
  /** "new": the bot's own Quick Preview tab. "active": attached to the user's current page. */
  target: "new" | "active";
  canResume?: boolean;
  state: "opening" | "ready" | "paused" | "closed" | "error";
  activity: string;
  error?: string;
}
