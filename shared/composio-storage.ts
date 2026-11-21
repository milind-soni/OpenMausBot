// The hosts Composio hands out file upload links on: its own storage (storage.composio.dev in its API reference), the
// AWS S3 storage behind it (its upload answer names `storage_backend: "s3"`), and Cloudflare R2's S3 API. R2 presigns
// to `<bucket>.<account-id>.r2.cloudflarestorage.com` (Composio's temporary bucket is `temp`) or the account endpoint
// itself. The account id is 32 hex digits; an optional jurisdiction (`eu`, `us`, `fedramp`) sits in front of `r2`.
// A file's bytes are put only to one of these, over HTTPS, so a link pointing anywhere else (this computer, a private
// address, another site) is never used.
const S3_HOST = /^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/;
const R2_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])\.)?[a-f0-9]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/;

export function composioStorageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "composio.dev" || host.endsWith(".composio.dev") || S3_HOST.test(host) || R2_HOST.test(host);
}

/** The link as a URL when it is HTTPS on Composio's storage, else null. */
export function composioUploadLink(link: string | undefined): URL | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return composioStorageHost(url.hostname) ? url : null;
}
