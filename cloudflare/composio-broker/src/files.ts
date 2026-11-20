// A connected-app tool that takes a file (Google Drive's GOOGLEDRIVE_UPLOAD_FILE, a Gmail attachment) reads it from
// Composio's file storage by `s3key`, never from the caller's disk. The app asks here for a place to put the file's
// bytes: Composio answers a one-time upload link and the key the tool call then names. The bytes go from the app to
// that link directly and never pass through this Worker.
import { z } from "zod";

import { composioUploadLink } from "../../../shared/composio-storage";
import { actingUser, composioRequest, json, listConnectedAccounts, readJsonBody, upstreamError, type InstallationRow } from "./common";

const uploadRequestSchema = z.object({
  toolkit_slug: z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,80}$/),
  tool_slug: z.string().regex(/^[A-Z0-9][A-Z0-9_]{0,127}$/),
  // A bare file name: no folder, no control characters.
  // eslint-disable-next-line no-control-regex
  filename: z.string().min(1).max(255).refine((name) => !/[\u0000-\u001f\u007f/\\]/.test(name)),
  mimetype: z.string().max(127).regex(/^[A-Za-z0-9][\w.+-]*\/[\w.+-]+$/),
  md5: z.string().regex(/^[0-9a-f]{32}$/),
}).strict();

const uploadResponseSchema = z.object({
  key: z.string().min(1).max(1024),
  new_presigned_url: z.string().optional(),
  newPresignedUrl: z.string().optional(),
});

/** POST /v1/files/upload: Composio's upload link and key for one file a tool call will name. Only for a toolkit the
 *  installation has a working connection to: nothing else could use the file. */
export async function requestFileUpload(request: Request, installation: InstallationRow, env: Env) {
  const parsed = uploadRequestSchema.safeParse(await readJsonBody(request, 4096));
  if (!parsed.success) return json({ error: "invalid file upload request" }, 400);
  const accounts = await listConnectedAccounts(env, actingUser(installation), [parsed.data.toolkit_slug]).catch(() => null);
  if (!accounts) return json({ error: "Connected apps could not be checked. Try again." }, 502);
  if (!accounts.some((account) => /^active$/i.test(account.status ?? "") && account.toolkit?.slug?.toLowerCase() === parsed.data.toolkit_slug)) {
    return json({ error: `${parsed.data.toolkit_slug} is not connected` }, 409);
  }
  const response = await composioRequest(env, "/files/upload/request", {
    method: "POST",
    body: JSON.stringify(parsed.data),
  });
  if (!response.ok) return json({ error: await upstreamError(response, `File upload request failed (${response.status})`) }, 502);
  const body = uploadResponseSchema.safeParse(await response.json().catch(() => null));
  const url = body.success ? composioUploadLink(body.data.new_presigned_url ?? body.data.newPresignedUrl) : null;
  if (!body.success || !url) return json({ error: "Composio returned no upload link on its storage" }, 502);
  return json({ key: body.data.key, url: url.toString() });
}
