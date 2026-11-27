// The community gallery's pictures. The catalog names each bot's picture by its path in the templates repository; the
// renderer never fetches from GitHub itself, so the catalog route reads each picture here (https to
// raw.githubusercontent.com only, no redirects, 64 KB at most, checked to be the picture its name says) and hands it on
// as a data: URL. A picture that can't be read is left out this time, and the card draws that bot's mascot instead.
import { TEAM_LIBRARY_RAW_ROOT, type TeamCatalog } from "./team-library.ts";

type Fetcher = typeof fetch;

const PICTURE_MAX_BYTES = 64 * 1024;
const MAX_PICTURES = 120;
const MAX_CACHED = 500;
const TYPES = { webp: "image/webp", png: "image/png", jpg: "image/jpeg" } as const;

const looksLike = (kind: keyof typeof TYPES, bytes: Uint8Array) => {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (kind === "webp") return bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (kind === "png") return bytes.length > 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG";
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
};

/** Pictures already read, by path. One that couldn't be read is tried again on the next catalog load. */
const cache = new Map<string, string>();

async function readPicture(path: string, fetcher: Fetcher): Promise<string | null> {
  const kind = path.slice(path.lastIndexOf(".") + 1) as keyof typeof TYPES;
  if (!(kind in TYPES)) return null;
  try {
    const response = await fetcher(`${TEAM_LIBRARY_RAW_ROOT}/${path.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { accept: "image/*" }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > PICTURE_MAX_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > PICTURE_MAX_BYTES || !looksLike(kind, bytes)) return null;
    return `data:${TYPES[kind]};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

/** The catalog with each named picture read into a data: URL, or left out. */
export async function withCatalogPictures(catalog: TeamCatalog, fetcher: Fetcher = fetch): Promise<TeamCatalog> {
  const paths = [...new Set(catalog.teams.flatMap((team) => (team.avatars ?? []).flatMap((face) => (face.picture ? [face.picture] : []))))]
    .slice(0, MAX_PICTURES);
  await Promise.all(paths.filter((path) => !cache.has(path)).map(async (path) => {
    const picture = await readPicture(path, fetcher);
    if (!picture) return;
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    cache.set(path, picture);
  }));
  return {
    ...catalog,
    teams: catalog.teams.map((team) => team.avatars ? {
      ...team,
      avatars: team.avatars.map(({ picture, ...face }) => {
        const read = picture ? cache.get(picture) : undefined;
        return read ? { ...face, picture: read } : face;
      }),
    } : team),
  };
}
