export interface TeamPlace { key: string; name: string; kind: "team"; read(): Promise<unknown> }
export function parseRemembered(value: unknown): Record<string, { name: string; bots: string[] }>;
export function botNames(body: unknown): string[];
export function teamPlaces(deps: {
  account(): { state(): any } | null;
  fetch: typeof fetch;
  remembered: { read(): unknown; write(value: unknown): void };
}): () => TeamPlace[];
