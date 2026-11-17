/** A limit read from the server's environment: a whole number from `min`; anything else leaves the default. */
export function envWhole(raw: string | undefined, fallback: number, min = 1): number {
  const value = Number(raw?.trim() || NaN);
  return Number.isSafeInteger(value) && value >= min ? value : fallback;
}
