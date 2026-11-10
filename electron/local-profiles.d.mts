import type { CloudSwatch } from "./cloud-list.mjs";
import type { CleanWorkspace } from "./clean-workspace.mjs";

export declare const PROFILES_FILE: "profiles.json";
export declare const PROFILE_NAME_LIMIT: number;
export declare const MAX_PROFILES: number;
export declare const SETTLE_POLL_MS: number;

/** One workspace of this computer's own, as the registry keeps it: `name` null is This Mac's own (This Mac or This PC). */
export interface ProfileEntry { id: string; name: string | null; color: CloudSwatch | null; createdAt: number }
export type ProfileRefusal = "name" | "taken" | "full" | "gone";

export function profileName(value: unknown): string | null;

export interface ProfileRegistry {
  list(): ProfileEntry[];
  get(id: string): ProfileEntry | null;
  create(input: { name: unknown; color?: unknown; reserved?: string | null }): { ok: true; profile: ProfileEntry } | { ok: false; error: ProfileRefusal };
  rename(id: string, name: unknown, reserved?: string | null): { ok: true } | { ok: false; error: ProfileRefusal };
  recolor(id: string, color: unknown): { ok: true } | { ok: false; error: ProfileRefusal };
  remove(id: string): boolean;
}
export function createProfileRegistry(deps: { dataDir(): string; fs?: typeof import("node:fs"); now?(): number; random?(): string }): ProfileRegistry;

/** A workspace as the rail lists it (cloud-rail.mjs railPlaces `profiles`). */
export interface ProfileRow { id: string; name: string | null; color: string | null; swatch: CloudSwatch | null; active?: true; settling?: string }

export interface LocalProfiles {
  places(input: { activeLocal: boolean }): ProfileRow[];
  settling(): { id: string | null; name: string } | null;
  creatable(): boolean;
  open(id: string): Promise<boolean | null>;
  computer(): Promise<boolean | null>;
  cancel(): void;
  create(input: { name: unknown; color?: unknown }): { outcome: "made"; id: string } | { outcome: "name" | "taken" | "failed" };
  rename(id: string, name: unknown): { outcome: "saved" | ProfileRefusal };
  recolor(id: string, color: unknown): { outcome: "saved" | ProfileRefusal };
  remove(id: string): Promise<{ outcome: "removed" | "gone" | "failed" }>;
  name(id: string): string | null;
}
export function createLocalProfiles(deps: {
  registry: ProfileRegistry;
  clean: CleanWorkspace;
  dataDir(): string;
  home(): "cloud" | "local" | null;
  window: { openProfile(id: string): Promise<boolean>; profile(): string | null; showCloud(): Promise<unknown> };
  showLocal(): unknown;
  onLocal(): boolean;
  busy(): Promise<{ name: string; what?: string } | null>;
  trash(dir: string): Promise<void>;
  reserved?(): string | null;
  allowed?(): boolean;
  remember?(place: { profile: string } | null): void;
  changed?(): void;
  log?(line: string): void;
  fs?: typeof import("node:fs");
  sleep?(ms: number): Promise<void>;
  now?(): number;
}): LocalProfiles;
