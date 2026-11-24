// What each release brought: announcements/releases.json on main, kept by the shared remote-file store (remote-file.ts)
// beside the announcement cards, and handed to pages with them at GET /api/announcements.
import { join } from "node:path";

import bundledReleasesJson from "../../announcements/releases.json" with { type: "json" };
import { parseReleaseFeed, RELEASES_URL, type ReleaseEntry, type ReleaseFeed } from "../../shared/release-notes.ts";
import { DATA_DIR } from "../config.ts";
import { RemoteJsonFile, type RemoteFileOptions } from "./remote-file.ts";

/** Twenty releases' notes come to about 60 KB. */
export const RELEASES_MAX_BYTES = 128 * 1024;

const parsedBundle = parseReleaseFeed(bundledReleasesJson, { strict: true, nowMs: Number.MAX_SAFE_INTEGER / 2 });
if (!parsedBundle.ok) throw new Error(`The bundled release notes are invalid (${parsedBundle.error})`);
export const BUNDLED_RELEASES: ReleaseFeed = parsedBundle.feed;

export function releasesCachePath(dataDir: string): string {
  return join(dataDir, "providers", "announcements", "releases.json");
}

export interface ReleaseNotesStoreOptions extends RemoteFileOptions {
  bundled?: ReleaseFeed;
}

export class ReleaseNotesStore extends RemoteJsonFile<ReleaseFeed> {
  constructor(options: ReleaseNotesStoreOptions) {
    super(options, {
      name: "release notes",
      url: RELEASES_URL,
      cachePath: releasesCachePath(options.dataDir),
      bundled: options.bundled ?? BUNDLED_RELEASES,
      maxBytes: RELEASES_MAX_BYTES,
      parse: (value, nowMs) => {
        const parsed = parseReleaseFeed(value, { nowMs });
        return parsed.ok ? { ok: true, value: parsed.feed, skipped: parsed.skipped } : parsed;
      },
      updatedAt: (feed) => feed.updatedAt,
    });
  }

  /** Newest first; nothing when switched off. */
  releases(): ReleaseEntry[] {
    return this.disabled ? [] : this.current().releases;
  }
}

let store: ReleaseNotesStore | undefined;

export function releaseNotesStore(): ReleaseNotesStore {
  return store ??= new ReleaseNotesStore({ dataDir: DATA_DIR });
}
