import { describe, expect, it } from "vitest";
import {
  SECRET_REF_PREFIX,
  accountFor,
  configuredSecretBackend,
  isSecretRef,
  libsecretBackend,
  macKeychainBackend,
  memoryBackend,
  sealSecrets,
  unsealSecrets,
} from "./secret-store.ts";

const sample = {
  xai: { key: "xai-123", url: "https://api.x.ai" },
  composio: { apiKey: "ak_456", userId: "u1" },
  opencodeGo: { apiKey: "oc", providerKeys: { OPENROUTER_API_KEY: "or-1", EMPTY: "" } },
  instances: { openaiCompat: { config: { key: "sk-9", apiKeyEnv: "OPENAI_COMPAT_API_KEY", url: "http://x" } } },
  tts: { provider: "fish", fishKey: "fish-1", voice: "v" },
  live: { enabled: true, port: 8799 },
  list: [{ token: "t-1" }],
};

describe("secret store", () => {
  it("moves every credential out and leaves references", () => {
    const backend = memoryBackend();
    const { config, stored, failed } = sealSecrets(sample, backend);
    const text = JSON.stringify(config);
    for (const secret of ["xai-123", "ak_456", "oc", "or-1", "sk-9", "fish-1", "t-1"]) expect(text).not.toContain(`"${secret}"`);
    expect(stored).toBe(7);
    expect(failed).toEqual([]);
    expect((config as any).instances.openaiCompat.config.apiKeyEnv).toBe("OPENAI_COMPAT_API_KEY");
    expect((config as any).xai.url).toBe("https://api.x.ai");
    expect((config as any).opencodeGo.providerKeys.EMPTY).toBe("");
    expect(isSecretRef((config as any).xai.key)).toBe(true);
  });

  it("round-trips to the original", () => {
    const backend = memoryBackend();
    const sealed = sealSecrets(sample, backend).config;
    expect(unsealSecrets(sealed, backend)).toEqual({ config: sample, missing: [] });
  });

  it("is idempotent: references are never stored as secrets", () => {
    const backend = memoryBackend();
    const once = sealSecrets(sample, backend).config;
    const twice = sealSecrets(once, backend);
    expect(twice.config).toEqual(once);
    expect(twice.stored).toBe(0);
  });

  it("drops a reference whose secret vanished instead of leaking the reference as a key", () => {
    const { config, missing } = unsealSecrets({ xai: { key: `${SECRET_REF_PREFIX}xai.key`, url: "u" } }, memoryBackend());
    expect(config).toEqual({ xai: { url: "u" } });
    expect(missing).toEqual(["xai.key"]);
  });

  it("keeps a secret in the file when the backend refuses it", () => {
    const backend = { name: "broken", get: () => undefined, set: () => { throw new Error("locked"); } };
    const { config, failed } = sealSecrets({ xai: { key: "k" } }, backend);
    expect(config).toEqual({ xai: { key: "k" } });
    expect(failed).toEqual(["xai.key"]);
  });

  it("escapes dots so two paths never share an account", () => {
    expect(accountFor(["a.b", "c"])).not.toBe(accountFor(["a", "b.c"]));
  });

  it("is off unless OMB_SECRET_STORE asks for it, and off on platforms without a backend", () => {
    expect(configuredSecretBackend({}, "darwin")).toBeUndefined();
    expect(configuredSecretBackend({ OMB_SECRET_STORE: "file" }, "darwin")).toBeUndefined();
    expect(configuredSecretBackend({ OMB_SECRET_STORE: "keychain" }, "win32")).toBeUndefined();
    expect(configuredSecretBackend({ OMB_SECRET_STORE: "keychain" }, "darwin")?.name).toBe("macOS Keychain");
    expect(configuredSecretBackend({ OMB_SECRET_STORE: "os" }, "linux")?.name).toBe("Secret Service (libsecret)");
  });

  it("macOS backend never puts the value on argv", () => {
    const calls: { args: string[]; input?: string }[] = [];
    const store = new Map<string, string>();
    const exec = (_file: string, args: string[], input?: string) => {
      calls.push({ args, input });
      if (args[0] === "-i") {
        const value = /-w "((?:[^"\\]|\\.)*)"/.exec(input ?? "")![1].replace(/\\(.)/g, "$1");
        store.set("acct", value);
        return "";
      }
      const found = store.get("acct");
      if (found === undefined) throw Object.assign(new Error("nf"), { status: 44 });
      return `${found}\n`;
    };
    const backend = macKeychainBackend(exec);
    expect(backend.get("acct")).toBeUndefined();
    backend.set("acct", 'p"a\\ss');
    expect(backend.get("acct")).toBe('p"a\\ss');
    expect(calls.every((call) => !call.args.join(" ").includes("p\"a"))).toBe(true);
  });

  it("libsecret backend sends the value on stdin", () => {
    let input: string | undefined;
    const backend = libsecretBackend((_file, args, stdin) => {
      if (args[0] === "store") input = stdin;
      return "";
    });
    backend.set("x", "s3cret");
    expect(input).toBe("s3cret");
    expect(backend.get("x")).toBeUndefined();
  });
});
