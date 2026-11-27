export const PERSON_AWAY_SECONDS: number;
/** Whether a lent screen call would take the person's mouse, keyboard or front window. */
export function takesForeground(name: string, args: unknown): boolean;
export function personActiveText(name: string): string;
export function createLentScreenPresence(options?: { idleSeconds?: () => number | null; now?: () => number }): {
  refusal(name: string, args: unknown): string | null;
  acted(name: string, args: unknown): void;
};
