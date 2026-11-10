// Helpers shared by every connector provider; free of any one backend's transport or config.
import { z } from "zod";
import { canonicalToolkitSlug, inputError } from "../composio-project.ts";

export const printableAliasSchema = z.string().min(1).max(64).refine((value) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
  }
  return true;
});

export function normalizeAccountAlias(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = z.string().safeParse(value);
  if (!parsed.success) throw inputError("Account alias must be text");
  const alias = parsed.data.trim();
  if (!printableAliasSchema.safeParse(alias).success) {
    throw inputError("Account alias must be 1-64 printable characters");
  }
  return alias;
}

/** Composio lists meta.categories as `{ id, name }` objects (older payloads: plain strings). */
export function toolkitCategories(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = raw
    .map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined)
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim().slice(0, 40))
    .filter(Boolean);
  const unique = [...new Set(names)].slice(0, 4);
  return unique.length ? unique : undefined;
}

export function canonicalServiceRecord<T>(services: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(services).map(([slug, state]) => [canonicalToolkitSlug(slug), state]),
  );
}

export function requestedServiceRecord<T>(services: Record<string, T>, requested: string[]): Record<string, T> {
  const canonical = canonicalServiceRecord(services);
  return Object.fromEntries(
    requested.flatMap((slug) => {
      const key = canonicalToolkitSlug(slug);
      const state = Object.hasOwn(canonical, key) ? canonical[key] : undefined;
      return state === undefined ? [] : [[slug, state]];
    }),
  );
}

export function decodeConnectedAccountId(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}
