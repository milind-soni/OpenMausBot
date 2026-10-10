// The reel's scenes, all drawn in code: no recordings to ship, and every
// skin and locale gets the same picture. REEL is the order they play in;
// each scene reports its own mascot cues and its own end.
import type { ComponentType } from "react";
import { AgentChat } from "./AgentChat";
import { Automations } from "./Automations";
import { Channels } from "./Channels";
import { Hands } from "./Hands";
import { Setup } from "./Setup";
import { Terminal } from "./Terminal";
import type { SceneProps } from "./types";

export type { SceneProps };

const SCENES: Record<string, ComponentType<SceneProps>> = {
  agents: AgentChat,
  automations: Automations,
  channels: Channels,
  hands: Hands,
  setup: Setup,
  terminal: Terminal,
};

/** Scene ids in playing order. */
export const REEL = ["agents", "hands", "setup", "channels", "automations", "terminal"] as const;

export function sceneFor(id: string): ComponentType<SceneProps> | null {
  return SCENES[id] ?? null;
}
