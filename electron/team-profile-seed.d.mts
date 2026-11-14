export const SEED_PICTURE_MAX_BYTES: number;

export function seedTeamProfile(deps: {
  origin: string;
  teamFetch: typeof fetch;
  localRequest(route: string, init?: RequestInit): Promise<Response>;
  tries?: number;
  wait?(ms: number): Promise<void>;
  log?(line: string): void;
}): Promise<"seeded" | "nothing" | "signed-out" | "failed">;

export function createTeamProfileSeeds(deps: Omit<Parameters<typeof seedTeamProfile>[0], "origin">): { opened(origin: string): void };
