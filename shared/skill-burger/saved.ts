// A saved burger as lists show it: its name, the summary on its top bun, one entry per layer, and its args.
import type { LayerKind } from "./layers.ts";

export interface SavedWorkflowLayer { kind: LayerKind; app?: string; label: string }
export interface SavedWorkflow { name: string; summary: string; sha256: string; savedAt: string; layers: SavedWorkflowLayer[]; args: string[] }
