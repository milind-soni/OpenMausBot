// "unavailable" (could not read) must never look like "empty": a caller would register a fresh installation over the real one.
// macOS says "temporarily unavailable. Please try again." for a keychain that is busy at launch, so retry briefly first.
export const CREDENTIAL_READ_DELAYS_MS = [100, 200, 400, 800];

const message = (error) => (error instanceof Error ? error.message : String(error));

export async function readSecureCredentials({
  exists,
  isAvailable,
  readFile,
  decrypt,
  sleep,
  delays = CREDENTIAL_READ_DELAYS_MS,
}) {
  if (!exists()) return { status: "empty", credentials: {} };

  let lastError = "the operating-system credential store is unavailable";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    try {
      if (!(await isAvailable())) {
        lastError = "the operating-system credential store is unavailable";
        continue;
      }
      const decrypted = await decrypt(readFile());
      const text = typeof decrypted === "string" ? decrypted : decrypted?.result;
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { status: "unavailable", credentials: {}, error: "the credential store is not readable" };
        }
        return { status: "ok", credentials: parsed };
      } catch {
        return { status: "unavailable", credentials: {}, error: "the credential store is not readable" };
      }
    } catch (error) {
      lastError = message(error);
    }
  }
  return { status: "unavailable", credentials: {}, error: lastError };
}

/** "Reset saved keys" for a store that cannot be read: after the person confirms, the file is moved aside (kept, not
 * deleted) and the app restarts with an empty store it can write again. A store that was read is never touched, and
 * nothing moves once the app has begun to quit while the person was deciding, since no restart would follow. */
export async function resetUnreadableCredentials({ unreadable, confirm, quitting, exists, moveAside, failed, restart }) {
  if (!unreadable) return "readable";
  if (!(await confirm())) return "cancelled";
  if (quitting()) return "quitting";
  try {
    if (exists()) moveAside();
  } catch (error) {
    await failed(error);
    return "failed";
  }
  restart();
  return "reset";
}
