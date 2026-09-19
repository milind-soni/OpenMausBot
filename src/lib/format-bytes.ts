/** One byte formatter for every surface: whole bytes under a KiB, then one
 * decimal through KB and MB — so a chip, a gauge, and a warning can never
 * disagree about the same file. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
