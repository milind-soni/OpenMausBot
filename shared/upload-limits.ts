/** Below Cloudflare's transport ceiling; a local inbox, not unbounded storage. */
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const BROWSER_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The per-file ceiling every path enforces: uploads, browser staging, cloud sends
 * and message-file reads. A self-hosted admin can raise it with OMB_FILE_MAX_BYTES
 * without patching the installed app; a missing or invalid value keeps the
 * shipped 25 MiB. Stay under whatever sits in front of the server — the transport
 * that carries a 25 MiB upload does not automatically carry more.
 */
export function fileMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OMB_FILE_MAX_BYTES?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : FILE_MAX_BYTES;
}
