// Types for the prebuilt mascot-3d bundle (น้อง Connect, three.js r180 inside), only what this app calls.
export interface MascotBrandInput {
  name?: string;
  logo?: string | null;
  emblem?: "bars" | "logo";
  badge?: boolean;
  badgeText?: string;
  colors?: Partial<Record<"body" | "bodyShade" | "visor" | "face" | "ink" | "dark" | "trim" | "pod" | "emblem" | "ring" | "accent" | "badge", string>>;
  autoColors?: boolean;
}

export type MascotMood = "idle" | "attention" | "thinking" | "listening" | "talking" | "success" | "concerned";

export interface MascotOptions {
  brand?: MascotBrandInput;
  autoplay?: boolean;
  napAfter?: number;
  reactions?: boolean;
  interactive?: boolean;
  followPointer?: boolean;
  fps?: number;
  pixelRatio?: number;
}

export interface Mascot {
  readonly canvas: HTMLCanvasElement;
  setMood(mood: MascotMood): void;
  play(name: string): boolean;
  dispose(): void;
}

export function createMascot(container: HTMLElement, options?: MascotOptions): Mascot;
export function supported(): boolean;
