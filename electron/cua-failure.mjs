/** @trycua/cua-driver 0.28.2's errors carry only their kind as a message ("EmbeddedDriverError.Spawn"); the reason the
 * system gave, the exit code or the timeout is in `inner`. */
export function driverFailure(error) {
  const kind = typeof error?.tag === "string" ? error.tag : null;
  const inner = error?.inner && typeof error.inner === "object" ? error.inner : null;
  if (!kind || !inner) return String(error?.message ?? error);
  const said = Object.entries(inner).filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key} ${String(value)}`);
  return said.length ? `${kind}: ${said.join("; ")}` : kind;
}
