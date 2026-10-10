// Reading the OS-encrypted credential store (credentials.bin via safeStorage).
//
// The whole point of this module is one distinction main.mjs used to lose:
//
//   empty        the store was read, and the user has saved nothing
//   ok           the store was read, here is what is in it
//   unavailable  the store could NOT be read — we know nothing
//
// Those first two are facts. The third is ignorance, and it must not be
// spelled the same way as "empty": a caller that cannot tell them apart
// starts the app as though the user had never connected anything, and — far
// worse — registers a fresh installation over the top of the real one.
//
// macOS says "temporarily unavailable. Please try again." for a keychain that
// is merely busy at that instant, which is exactly what happens when the app
// asks a few hundred milliseconds too early. So we try again, briefly, before
// admitting ignorance.
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
  // delays.length retries AFTER the first attempt
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
        // Corruption is not a timing problem; retrying only delays the
        // report. It is still ignorance, never emptiness.
        return { status: "unavailable", credentials: {}, error: "the credential store is not readable" };
      }
    } catch (error) {
      lastError = message(error);
    }
  }
  return { status: "unavailable", credentials: {}, error: lastError };
}
