import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';

const RELEASE_REPOSITORIES = [
  'milind-soni/OpenMausBot',
  'milind-soni/openmausbot-releases',
] as const;
const RELEASES_PER_PAGE = 100;
const MAX_RELEASE_PAGES = 10;
const LEGACY_DRAFT_NOTES =
  /^Draft assembled by the release workflow from milind-soni\/OpenMausBot@([0-9a-f]{40})\. Edit these notes, then publish\.\s*$/i;

interface GitHubRelease {
  body: string | null;
  draft: boolean;
  html_url: string;
  name: string | null;
  prerelease: boolean;
  published_at: string | null;
  tag_name: string;
}

const markdownComponents: Components = {
  h1: ({ node: _node, ...props }) => <h3 {...props} />,
  h2: ({ node: _node, ...props }) => <h3 {...props} />,
  h3: ({ node: _node, ...props }) => <h4 {...props} />,
  a: ({ node: _node, ...props }) => <a {...props} rel="noreferrer" target="_blank" />,
};

function displayVersion(release: GitHubRelease) {
  return release.tag_name.replace(/^v(?=\d)/i, '') || release.name || 'Release';
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(new Date(value));
}

function parseVersion(tag: string): readonly [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
) {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function releaseNotes(release: GitHubRelease) {
  const body = release.body?.trim();
  if (!body) return 'No release notes were provided for this build.';

  const legacyDraft = LEGACY_DRAFT_NOTES.exec(body);
  if (!legacyDraft) return body;

  const commit = legacyDraft[1];
  return `This build predates curated release notes. [View its source commit (${commit.slice(0, 7)})](https://github.com/milind-soni/OpenMausBot/commit/${commit}).`;
}

async function fetchPublishedReleases(repository: string): Promise<GitHubRelease[]> {
  try {
    const token = process.env.GITHUB_RELEASES_TOKEN ?? process.env.GITHUB_TOKEN;
    const releases: GitHubRelease[] = [];
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      const endpoint = `https://api.github.com/repos/${repository}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`;
      const response = await fetch(endpoint, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'OpenMausBot-docs',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        next: { revalidate: 300 },
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const pageReleases: unknown = await response.json();
      if (!Array.isArray(pageReleases)) throw new Error('GitHub returned an invalid release list');
      releases.push(...(pageReleases as GitHubRelease[]));
      if (pageReleases.length < RELEASES_PER_PAGE) break;
      if (page === MAX_RELEASE_PAGES) throw new Error('release history exceeded the pagination limit');
    }
    return releases.filter(
      (release) => !release.draft && !release.prerelease && release.published_at,
    );
  } catch (error) {
    console.warn(`[docs] Could not load releases from ${repository}:`, error);
    return [];
  }
}

async function publishedReleases(): Promise<GitHubRelease[]> {
  const [canonical, legacy] = await Promise.all(
    RELEASE_REPOSITORIES.map((repository) => fetchPublishedReleases(repository)),
  );
  const byTag = new Map<string, GitHubRelease>();

  for (const release of [...canonical, ...legacy]) {
    const tag = release.tag_name.trim().toLowerCase();
    if (!byTag.has(tag)) byTag.set(tag, release);
  }

  return [...byTag.values()]
    .map((release) => ({ release, version: parseVersion(release.tag_name) }))
    .filter(
      (
        entry,
      ): entry is {
        release: GitHubRelease;
        version: readonly [number, number, number];
      } => Boolean(entry.version),
    )
    .sort((left, right) => compareVersions(right.version, left.version))
    .map(({ release }) => release);
}

export async function ReleaseChangelog() {
  const releases = await publishedReleases();
  if (releases.length === 0) {
    return (
      <p>
        The live release history is temporarily unavailable.{' '}
        <a href="https://github.com/milind-soni/OpenMausBot/releases">Browse releases on GitHub</a>.
      </p>
    );
  }

  return (
    <div className="mt-8">
      {releases.map((release) => {
        const version = displayVersion(release);
        return (
          <article className="mb-12" key={release.tag_name}>
            <h2>
              {version} — {displayDate(release.published_at!)}
            </h2>
            <ReactMarkdown components={markdownComponents}>
              {releaseNotes(release)}
            </ReactMarkdown>
            <p>
              <a href={release.html_url} rel="noreferrer" target="_blank">
                Full {version} release notes
              </a>
            </p>
          </article>
        );
      })}
    </div>
  );
}
