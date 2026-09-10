/** Older hosts return only a message/status pair. Do not hide unrelated
 * 409s such as missing configuration or an incompatible desktop image. */
export function isRemoteScreenshotContention(error: { status: number; message: string }): boolean {
  return error.status === 409 && [
    "this bot's cloud computer is being changed — wait for it to finish",
    "the VPS is being prepared — try again shortly",
    "VPS connection settings are being updated — wait for them to finish",
    "Box account settings are being updated — wait for them to finish",
  ].includes(error.message);
}

export function remoteScreenshotSource(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as { png?: unknown; format?: unknown };
  if (typeof frame.png !== "string" || !frame.png || !/^[A-Za-z0-9+/=]+$/.test(frame.png)) return null;
  if (frame.format !== "png" && frame.format !== "jpeg") return null;
  return `data:${frame.format === "jpeg" ? "image/jpeg" : "image/png"};base64,${frame.png}`;
}
