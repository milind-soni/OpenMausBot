// The hosts Composio hands out file upload links on: its own storage (storage.composio.dev in its API reference) and the
// AWS S3 storage behind it (its upload answer names `storage_backend: "s3"`). A file's bytes are put only to one of
// these, over HTTPS, so a link pointing anywhere else (this computer, a private address, another site) is never used.
const S3_HOST = /^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/;

export function composioStorageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "composio.dev" || host.endsWith(".composio.dev") || S3_HOST.test(host);
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
