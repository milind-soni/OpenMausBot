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

/** Only enumerable string keys enter credentials.bin; prototypes and __proto__ never cross. */
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

/** Every caller derives its next document from the latest committed one in the same queue; a failed `afterPersist`
 * restores the encrypted file before another mutation begins. */
export function createSecureCredentialState(initialCredentials, persist, { writable = true } = {}) {
  let current = copy(initialCredentials);
  let transition = Promise.resolve();

  // A store that could not be read starts from {}: writing from it would replace every secret with nothing.
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
          await persist(copy(previous));
          current = previous;
          throw error;
        }
      });
    },
  };
}
