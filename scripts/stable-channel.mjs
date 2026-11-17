// The checks and the record behind .github/workflows/promote-stable.yml: which released version the `stable` channel
// names. The record is stable.json on the `channels` branch, which a self-hosted server reads over plain HTTPS
// (server/update-check.ts, deploy/update.sh): no registry API, no token.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** How long our own Clouds run a release before it may be promoted. */
export const SOAK_MS = 48 * 60 * 60_000;
/** Apps work with any server that was the stable one within this long; the record keeps that much history. */
export const SKEW_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;

/** "v0.1.151" or "0.1.151" → "0.1.151"; anything else, a prerelease included, is refused. */
export function stableVersion(input) {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(String(input ?? "").trim());
  if (!match) throw new Error(`"${input}" is not a released version: give it as X.Y.Z, such as 0.1.151`);
  return match[1];
}

const parts = (version) => version.split(".").map(Number);
/** Negative when `a` is older than `b`. */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** `release`: `gh release view --json tagName,isDraft,isPrerelease,publishedAt,url`. Throws unless it is published and soaked. */
export function checkRelease(release, version, { now, urgent = false }) {
  if (release?.tagName !== `v${version}`) throw new Error(`v${version} is not a release of this repository`);
  if (release.isDraft) throw new Error(`v${version} is still a draft: publish it first`);
  if (release.isPrerelease) throw new Error(`v${version} is a prerelease, and stable only takes full releases`);
  const published = Date.parse(release.publishedAt ?? "");
  if (!Number.isFinite(published)) throw new Error(`v${version} has no publish date`);
  const waited = now - published;
  if (waited < SOAK_MS && !urgent) {
    throw new Error(`v${version} was published ${Math.floor(waited / 3_600_000)} hours ago; stable takes a version our Clouds have run for 48 hours. For a fix that cannot wait, run this again with "urgent" ticked.`);
  }
}

/** `index`: the tag's raw manifest. Throws unless it is an image index with every platform of `platforms` ("linux/amd64"). */
export function checkIndex(index, platforms, name) {
  if (!Array.isArray(index?.manifests)) throw new Error(`${name} is not a multi-platform image`);
  const has = new Set(index.manifests.map((manifest) => `${manifest.platform?.os}/${manifest.platform?.architecture}`));
  const missing = platforms.filter((platform) => !has.has(platform));
  if (missing.length) throw new Error(`${name} has no image for ${missing.join(" or ")}`);
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The next stable.json. `current` is the record it replaces (null for the first). Throws when `version` is older than
 * the current one, unless `allowOlder`. Promoting the current version again changes nothing but the images, if those moved.
 */
export function stableRecord({ version, image, cloudHomeImage, release, current, now, allowOlder = false }) {
  for (const ref of [image, cloudHomeImage]) if (!DIGEST.test(ref.split("@")[1] ?? "")) throw new Error(`${ref} is not pinned by digest`);
  if (current && compareVersions(version, current.version) < 0 && !allowOlder) {
    throw new Error(`stable is ${current.version}, which is newer than ${version}. To move stable back, run this again with "allow older" ticked.`);
  }
  const promotedAt = current?.version === version ? current.promotedAt : new Date(now).toISOString();
  const earlier = (current?.history ?? []).filter((entry) => entry.version !== version);
  // Everything that was stable within the skew window: the newest entry older than the window was stable at its start.
  const cutoff = now - SKEW_DAYS * DAY_MS;
  const kept = earlier.filter((entry, at) => Date.parse(entry.promotedAt) >= cutoff || at === 0 || Date.parse(earlier[at - 1].promotedAt) >= cutoff);
  return {
    channel: "stable",
    version,
    image,
    cloudHomeImage,
    platforms: ["linux/amd64", "linux/arm64"],
    releaseUrl: release.url,
    releasedAt: release.publishedAt,
    promotedAt,
    history: [{ version, promotedAt }, ...kept],
  };
}

function flags(argv) {
  const found = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    const name = argv[i].slice(2);
    if (name === "urgent" || name === "allow-older") found[name] = true;
    else found[name] = argv[++i];
  }
  return found;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function main([command, ...rest]) {
  if (command === "version") return console.log(stableVersion(rest[0]));
  const options = flags(rest);
  if (command === "check-release") return checkRelease(readJson(options.release), stableVersion(options.version), { now: Date.now(), urgent: options.urgent === true });
  if (command === "check-image") return checkIndex(readJson(options.index), options.platforms.split(","), options.name);
  if (command === "record") {
    const record = stableRecord({
      version: stableVersion(options.version), image: options.image, cloudHomeImage: options["cloud-home"], release: readJson(options.release),
      current: options.current ? readJson(options.current) : null, now: Date.now(), allowOlder: options["allow-older"] === true,
    });
    return console.log(JSON.stringify(record, null, 2));
  }
  throw new Error("usage: stable-channel.mjs version <X.Y.Z> | check-release | check-image | record");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
