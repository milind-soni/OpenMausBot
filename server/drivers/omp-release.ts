import { z } from "zod";

// The newest stable omp, read from npm (omp's own installers publish the same
// version as @oh-my-pi/pi-coding-agent). Freshness only drives the Engines
// update notice; it never makes an installed omp unavailable.
/** Parse semver or `omp --version` output, including whitespace-separated CLI
 * annotations. `version` is the semver token without a CLI or `v` prefix. */
export function parseOmpVersion(value: string): {
  version: string;
  parts: [number, number, number];
  prerelease: boolean;
} | null {
  const input = value.trim();
  const prefix = /^(?:omp\/|omp[ \t]+)v?/i.exec(input);
  const token = prefix ? input.slice(prefix[0].length) : input.replace(/^v/i, "");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9a-z-]+(?:\.[0-9a-z-]+)*))?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?=$|\s)/i.exec(token);
  if (!match || (!prefix && match[0].length !== token.length)) return null;
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parts.every(Number.isSafeInteger)) return null;
  const prerelease = match[4];
  if (prerelease?.split(".").some((identifier) => /^0\d+$/.test(identifier))) return null;
  return { version: match[0], parts, prerelease: prerelease !== undefined };
}

const releasePayloadSchema = z.object({ version: z.string() });

/** Whether `installed` (`omp/18.4.12`, `omp v18.4.12`, `18.4.12`) is older
 * than the stable `latest`. Unreadable versions and prerelease "latest"
 * values never claim an update. */
export function ompVersionBehind(installed: string, latest: string): boolean {
  const a = parseOmpVersion(installed);
  const b = parseOmpVersion(latest);
  if (!a || !b || b.prerelease) return false;
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i]! < b.parts[i]!;
  }
  return a.prerelease;
}

export function createOmpReleaseReader(fetchImpl: typeof fetch = fetch, now = Date.now) {
  let cached: Promise<string | null> | undefined;
  let expires = 0;
  return (): Promise<string | null> => {
    if (cached && now() < expires) return cached;
    expires = now() + 60 * 60 * 1000;
    cached = (async () => {
      try {
        const response = await fetchImpl("https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest", {
          signal: AbortSignal.timeout(3000),
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("Release lookup failed");
        const { version } = releasePayloadSchema.parse(await response.json());
        const parsed = parseOmpVersion(version);
        // npm's version field is plain semver, never annotated CLI output.
        if (!parsed || parsed.prerelease || parsed.version !== version) throw new Error("Invalid stable release");
        return version;
      } catch {
        // Offline checks must not make an otherwise usable engine unavailable.
        expires = now() + 5 * 60 * 1000;
        return null;
      }
    })();
    return cached;
  };
}

export const readLatestOmpRelease = createOmpReleaseReader();
