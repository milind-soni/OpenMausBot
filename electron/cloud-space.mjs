// Room on the person's Cloud for what goes there: whether it fits now, fits once its volume grows (the Admin's grow, in
// steps of its own), or never fits on this plan. The one-time move measures before it sends files and attachments.
const SPACE_MARGIN = 256 * 1024 ** 2;
const GB = 1024 ** 3;
/** Must match openmaus-cloud's VOLUME_EXTEND step. */
const DISK_STEP_GB = 10;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

/** `copies`: how many times the bytes take room there while they arrive (a whole-workspace copy needs three). */
export function moveFit({ localBytes, freeBytes, uploadReceived = 0, volumeBytes = null, disk = null, copies = 3 }) {
  const neededBytes = copies * localBytes + SPACE_MARGIN, available = freeBytes + uploadReceived;
  const maxBytes = count(disk?.maxBytes) && disk.maxBytes > 0 ? disk.maxBytes : null;
  const volume = [volumeBytes, disk?.volumeBytes, disk?.startBytes].find(value => count(value) && value > 0) ?? null;
  if (available >= neededBytes) return { fit: "now", neededBytes, freeBytes: available };
  const room = maxBytes && volume && maxBytes > volume ? maxBytes - volume : 0;
  if (room > 0 && available + room >= neededBytes) {
    const sizeGb = Math.min(Math.floor(maxBytes / GB), Math.ceil((volume + neededBytes - available) / GB / DISK_STEP_GB) * DISK_STEP_GB);
    return { fit: "grow", neededBytes, freeBytes: available, maxBytes, sizeGb };
  }
  return { fit: "never", neededBytes, freeBytes: available, ...(maxBytes ? { maxBytes, ...(disk?.largest === true ? { largest: true } : {}) } : volume ? { volumeBytes: volume } : {}) };
}

/** Has the Admin grow the volume to `fit.sizeGb`, then waits until `free()` reports the room: "grown", or why not. */
export async function growToFit(fit, { grow, free, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollMs = 2_000, timeoutMs = 5 * 60_000, now = Date.now }) {
  let answer = null;
  try { answer = await grow(fit.sizeGb); } catch { return "unavailable"; }
  if (!answer?.supported) return "unsupported";
  if (answer.refused) return "full";
  for (const deadline = now() + timeoutMs; now() <= deadline; await sleep(pollMs)) {
    const bytes = await free().catch(() => null);
    if (Number.isFinite(bytes) && bytes >= fit.neededBytes) return "grown";
  }
  return "unavailable";
}
