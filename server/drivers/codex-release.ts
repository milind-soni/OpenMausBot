// Release freshness is independent of account-specific model availability.
function parseCodexReleaseVersion(value: string): { parts: number[]; prerelease: boolean } | null {
  const match = /^(?:.*\bcodex-cli\s+)?v?(\d+)\.(\d+)\.(\d+)(-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i.exec(value.trim());
  return match ? { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) } : null;
}

export function codexVersionBehind(installed: string, latest: string): boolean {
  const a = parseCodexReleaseVersion(installed);
  const b = parseCodexReleaseVersion(latest);
  if (!a || !b || b.prerelease) return false;
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i];
  }
  return a.prerelease;
}

export function createCodexReleaseReader(fetchImpl: typeof fetch = fetch, now = Date.now) {
  let cached: Promise<string | null> | undefined;
  let expires = 0;
  return (): Promise<string | null> => {
    if (cached && now() < expires) return cached;
    expires = now() + 60 * 60 * 1000;
    cached = (async () => {
      try {
        const response = await fetchImpl("https://registry.npmjs.org/@openai/codex/latest", {
          signal: AbortSignal.timeout(3000),
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("Release lookup failed");
        const payload = await response.json() as { version?: unknown };
        const version = typeof payload.version === "string" ? payload.version : "";
        const parsed = parseCodexReleaseVersion(version);
        if (!parsed || parsed.prerelease) throw new Error("Invalid stable release");
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

export const readLatestCodexRelease = createCodexReleaseReader();
