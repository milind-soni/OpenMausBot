import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const validKey = key => typeof key === "string" && /^omi_dev_[A-Za-z0-9_-]{1,2048}$/.test(key);
const maxBytes = 64 * 1024;

/** Stores only an OS-encrypted Omi developer key; encryption must reject plaintext OS backends. */
export function createIslandKeyStore({ file, encryption }) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new TypeError("An absolute key file path is required.");
  let tail = Promise.resolve();

  async function available() {
    if (!(await encryption.available())) throw new Error("Keychain unavailable");
  }

  return {
    async read() {
      await tail.catch(() => {});
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) throw new Error("Invalid encrypted record");
        await available();
        const decrypted = await encryption.decrypt(await handle.readFile());
        const key = typeof decrypted === "string" ? decrypted : decrypted?.result;
        if (!validKey(key)) throw new Error("Invalid developer key");
        return key;
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw new Error("Could not read the Omi key. Unlock your system keychain and try again.");
      } finally {
        await handle?.close();
      }
    },

    write(key) {
      const operation = tail.catch(() => {}).then(async () => {
        if (key !== null && !validKey(key)) throw new Error("Enter an Omi developer key beginning with omi_dev_.");
        let temporary;
        try {
          if (key === null) {
            try { await fs.unlink(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
            return;
          }
          await available();
          const encrypted = await encryption.encrypt(key);
          if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > maxBytes) throw new Error("Invalid encrypted record");
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          temporary = `${file}.${randomUUID()}.tmp`;
          const handle = await fs.open(temporary, "wx", 0o600);
          try {
            await handle.chmod(0o600);
            await handle.writeFile(encrypted);
            await handle.sync();
          } finally { await handle.close(); }
          await fs.rename(temporary, file);
        } catch {
          throw new Error(key === null
            ? "Could not remove the Omi key. Try disconnecting again."
            : "Could not save the Omi key. Unlock your system keychain and try again.");
        } finally {
          if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
        }
      });
      tail = operation;
      return operation;
    },
  };
}
