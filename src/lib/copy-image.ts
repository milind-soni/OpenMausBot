import type { CopyResult } from "./copy-text";

/** PNG is the one image type every browser clipboard accepts, so other types are redrawn as PNG first. */
export function canCopyImage(): boolean {
  return (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  );
}

async function drawAsPng(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("no png"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function imageAsPng(source: string, toPng: (blob: Blob) => Promise<Blob>): Promise<Blob> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`image ${response.status}`);
  const blob = await response.blob();
  return blob.type === "image/png" ? blob : toPng(blob);
}

/** The PNG goes in as a promise so Safari keeps the click's permission while the image loads. */
export async function copyImage(
  source: string,
  toPng: (blob: Blob) => Promise<Blob> = drawAsPng,
): Promise<CopyResult> {
  if (!canCopyImage()) return "failed";
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": imageAsPng(source, toPng) })]);
    return "copied";
  } catch {
    return "failed";
  }
}
