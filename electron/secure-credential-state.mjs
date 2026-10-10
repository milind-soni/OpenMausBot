const isPlainRecord = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const constructor = value.constructor;
    if (constructor === undefined || typeof constructor !== "function") return true;
    const prototype = constructor.prototype;
    return (
      typeof prototype === "object" &&
      prototype !== null &&
      Object.prototype.hasOwnProperty.call(prototype, "isPrototypeOf")
    );
  } catch {
    return false;
  }
};

/** Reproduce the former record-schema boundary without making zod a packaged
 * runtime dependency. Only enumerable string keys enter credentials.bin;
 * prototypes and the magic __proto__ key never cross the boundary. */
const copy = (credentials) => {
  if (!isPlainRecord(credentials)) {
    throw new TypeError("Secure credentials must be a plain record");
  }
  const document = {};
  for (const key of Reflect.ownKeys(credentials)) {
    if (!Object.prototype.propertyIsEnumerable.call(credentials, key)) continue;
    if (typeof key !== "string") {
      throw new TypeError("Secure credential keys must be strings");
    }
    if (key === "__proto__") continue;
    document[key] = credentials[key];
  }
  return structuredClone(document);
};

/** A serialized, copy-on-write view over credentials.bin.
 *
 * Every caller derives its next complete document from the latest committed
 * document while holding the same queue. This prevents an account sign-in,
 * API-key edit, and optional service registration from each persisting an old
 * snapshot over the other two. `afterPersist` supports changes that must also
 * be accepted by the local server: if that second phase fails, the encrypted
 * file is restored before another mutation may begin. */
export function createSecureCredentialState(initialCredentials, persist, { writable = true } = {}) {
  let current = copy(initialCredentials);
  let transition = Promise.resolve();

  // A launch that could not READ the store starts from {}. Deriving a new
  // document from {} and writing it would not add a secret — it would replace
  // every secret in the file with nothing, stranding the connected-apps
  // identity the user already authorized. Reads still work (callers get an
  // honest empty view); writes refuse, loudly, until a launch can read again.
  const assertWritable = () => {
    if (writable) return;
    throw new Error("The credential store could not be read on this launch, so credentials cannot be saved");
  };

  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  return {
    read() {
      return copy(current);
    },

    update(derive, afterPersist) {
      return serialize(async () => {
        assertWritable();
        const previous = copy(current);
        const next = copy(await derive(copy(previous)));
        await persist(copy(next));
        try {
          const result = await afterPersist?.(copy(next));
          current = next;
          return result ?? copy(next);
        } catch (error) {
          // Keep both the in-memory view and the encrypted file consistent
          // with the failed operation the caller observed.
          await persist(copy(previous));
          current = previous;
          throw error;
        }
      });
    },
  };
}
