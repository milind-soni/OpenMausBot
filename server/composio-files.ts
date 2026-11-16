// Where to put one file's bytes so a connected-app tool can read it by `s3key`: Composio's one-time upload link, asked
// for with the project key, or through the managed connection service, which holds the key
// (cloudflare/composio-broker/src/files.ts). Chosen the way relayMcp chooses: a member's own installation, else the
// project key, else the service.
import { z } from "zod";

import type { AppConfig } from "./config.ts";
import { brokerAccess, type BrokerAccess } from "./composio-broker-access.ts";
import { apiBase, projectHeaders, responseError } from "./composio-project.ts";
import { projectApiKey } from "./composio-session.ts";

export interface FileUploadRequest {
  toolkit_slug: string;
  tool_slug: string;
  filename: string;
  mimetype: string;
  md5: string;
}

const projectAnswerSchema = z.object({ key: z.string().min(1), new_presigned_url: z.string().optional(), newPresignedUrl: z.string().optional() });
const serviceAnswerSchema = z.object({ key: z.string().min(1), url: z.string().min(1) });

export async function requestFileUpload(cfg: AppConfig, request: FileUploadRequest, as?: BrokerAccess): Promise<{ key: string; url: string }> {
  const apiKey = as ? null : projectApiKey(cfg);
  const broker = apiKey ? null : as ?? brokerAccess();
  if (!apiKey && !broker) throw new Error("connected apps are unavailable");
  const response = await fetch(apiKey ? `${apiBase()}/files/upload/request` : `${broker!.url}/v1/files/upload`, {
    method: "POST",
    headers: apiKey ? projectHeaders(apiKey, true) : { authorization: `Bearer ${broker!.token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(await responseError(response, `the upload service answered HTTP ${response.status}`));
  const body: unknown = await response.json();
  const answer = apiKey ? projectAnswerSchema.parse(body) : serviceAnswerSchema.parse(body);
  const link = "url" in answer ? answer.url : answer.new_presigned_url ?? answer.newPresignedUrl;
  let url: URL | undefined;
  try { url = link ? new URL(link) : undefined; } catch {}
  // HTTPS only, as for the service itself; plain HTTP only to this computer (a service run locally for development).
  const loopback = url !== undefined && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) throw new Error("Composio returned no usable upload link");
  return { key: answer.key, url: url.toString() };
}
