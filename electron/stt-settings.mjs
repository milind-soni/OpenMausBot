import fs from "node:fs/promises";
import path from "node:path";
import { defaults, validateConfig, mergePublicConfig } from "./stt-core.mjs";

/** An unreadable store is an error, never an empty configuration to overwrite. */
export function createSttSettings(root, storage, platform = process.platform) {
  const encryptedFile = path.join(root, "settings.enc"), plainFile = path.join(root, "settings.json");
  let cached = null, queue = Promise.resolve();
  const hasKeys = cfg => Object.values(cfg.profiles || {}).some(profile => profile.key);
  async function load() {
    if (cached) return cached;
    let encrypted;
    try { encrypted = await fs.readFile(encryptedFile); }
    catch (error) {
      if (error.code !== "ENOENT") throw new Error("Transcription settings could not be read.");
      try {
        const plain = JSON.parse(await fs.readFile(plainFile, "utf8"));
        if (hasKeys(plain)) throw new Error("Unprotected credentials found.");
        cached = validateConfig(plain, platform);
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error("Transcription settings could not be read.");
        cached = validateConfig(defaults(platform), platform);
      }
    }
    if (encrypted) {
      let text;
      try { const result = await storage.decryptStringAsync(encrypted); text = typeof result === "string" ? result : result.result; }
      catch { throw new Error("Transcription settings could not be unlocked."); }
      try { cached = validateConfig(JSON.parse(text), platform); }
      catch { throw new Error("Saved transcription settings are invalid."); }
    }
    return cached;
  }
  function save(input) {
    const job = queue.then(async () => {
      const config = validateConfig(mergePublicConfig(await load(), input), platform);
      const secure = await storage.isAsyncEncryptionAvailable() && !(platform === "linux" && storage.getSelectedStorageBackend() === "basic_text");
      if (!secure && hasKeys(config)) throw new Error("Protected credential storage is unavailable. Set up the system keyring before saving an API key.");
      const target = secure ? encryptedFile : plainFile;
      const payload = secure ? await storage.encryptStringAsync(JSON.stringify(config)) : JSON.stringify(config);
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(target + ".tmp", payload, { mode: 0o600 });
      await fs.rename(target + ".tmp", target);
      await fs.rm(secure ? plainFile : encryptedFile, { force: true });
      cached = config;
      return config;
    });
    queue = job.catch(() => {});
    return job;
  }
  return { load, save };
}
