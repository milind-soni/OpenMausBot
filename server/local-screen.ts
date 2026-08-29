const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export interface LocalScreenFrame {
  png: string;
  format: "jpeg" | "png";
}
function privateFrameUrl(value: string | undefined): URL | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/frame"
      ? url
      : null;
  } catch {
    return null;
  }
}

export async function captureLocalScreenFrame({
  url = process.env.OMB_LOCAL_SCREEN_URL,
  token = process.env.OMB_LOCAL_SCREEN_TOKEN,
  request = fetch,
}: {
  url?: string;
  token?: string;
  request?: typeof fetch;
} = {}): Promise<LocalScreenFrame> {
  const endpoint = privateFrameUrl(url);
  if (!endpoint || !token) throw new Error("local screen preview is unavailable");
  const response = await request(endpoint, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("local screen capture failed");
  const media = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const format = media === "image/jpeg" ? "jpeg" : media === "image/png" ? "png" : null;
  if (!format) throw new Error("local screen capture returned an invalid image");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 512 || bytes.length > MAX_FRAME_BYTES) {
    throw new Error("local screen capture returned an invalid image");
  }
  return { png: bytes.toString("base64"), format };
}
