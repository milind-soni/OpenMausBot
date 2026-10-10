import type { MausState } from "@/lib/mascot";

export interface SceneProps {
  playing: boolean;
  onCue?: (state: MausState) => void;
  onEnded?: () => void;
  label: string;
}
