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
  canResume?: boolean;
  state: "opening" | "ready" | "paused" | "closed" | "error";
  activity: string;
  error?: string;
}
