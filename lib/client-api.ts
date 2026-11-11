export const localAppOrigin = () => window.location.origin;
export function navigateLocalApp(url: string) {
  window.location.assign(url);
}

export async function localFetch(path: string, sessionToken: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${sessionToken}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

export async function localApi<T>(path: string, sessionToken: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const response = await localFetch(path, sessionToken, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Request failed");
  return payload as T;
}

export type UploadedLocalFile = { id: string; name: string; size: number; contentType: string; projectId?: string };
/**
 * Uploads a chat or issue attachment: the API route checks access and returns a single-use Convex storage URL, and
 * the browser sends the bytes there directly (the route cannot accept a 15 MB body).
 */
export async function uploadLocalFile(path: string, sessionToken: string, file: File): Promise<UploadedLocalFile> {
  const contentType = file.type || "application/octet-stream";
  const { uploadUrl, file: saved } = await localApi<{ uploadUrl: string; file: UploadedLocalFile }>(path, sessionToken, { method: "POST", json: { name: file.name, size: file.size, contentType } });
  const response = await fetch(uploadUrl, { method: "POST", body: file, headers: { "Content-Type": contentType } });
  if (!response.ok) throw new Error(response.status === 413 ? "Files must be smaller than 15 MB" : "Upload failed. Try again.");
  return saved;
}
