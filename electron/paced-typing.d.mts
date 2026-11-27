export const MAX_PACED_CHARACTERS: number;
export function typesInOneBurst(platform: string, driverVersion: unknown, name: string, args: unknown): boolean;
export function typingUnits(text: string): string[];
export function withoutLeakedToolTags(text: string): string;
export function typeOneCharacterAtATime(
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  args: Record<string, unknown> & { text: string },
): Promise<Record<string, unknown>>;
