import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readEncryptionKey,
  SecureDingTalkCredentialFileProvider,
} from "./credentials.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "collaboration-credentials-"));
  scratch.push(path);
  return path;
}

describe("secure credential references", () => {
  it("loads 0600 credential files on every rotation without exposing values in state", () => {
    const directory = root();
    const path = join(directory, "dingtalk.json");
    writeFileSync(path, JSON.stringify({ clientId: "id-one", clientSecret: "secret-one" }), { mode: 0o600 });
    const provider = new SecureDingTalkCredentialFileProvider({ OMB_DINGTALK_CREDENTIAL_FILE: path });
    expect(provider.load()).toEqual({ clientId: "id-one", clientSecret: "secret-one" });
    writeFileSync(path, JSON.stringify({ clientId: "id-two", clientSecret: "secret-two" }), { mode: 0o600 });
    expect(provider.load()).toEqual({ clientId: "id-two", clientSecret: "secret-two" });
    expect(JSON.stringify({ configured: provider.load() !== null })).not.toContain("secret-two");
  });

  it("rejects group-readable files and invalid encryption keys", () => {
    const directory = root();
    const path = join(directory, "credential");
    writeFileSync(path, "secret", { mode: 0o600 });
    chmodSync(path, 0o640);
    expect(() => new SecureDingTalkCredentialFileProvider({ OMB_DINGTALK_CREDENTIAL_FILE: path }).load()).toThrow(
      "permissions",
    );
    chmodSync(path, 0o600);
    expect(() => readEncryptionKey(path)).toThrow("backup_key_must_be_32_bytes");
  });

  it("rejects symlinks and supports raw 32-byte backup keys", () => {
    const directory = root();
    const target = join(directory, "target");
    const link = join(directory, "link");
    writeFileSync(target, Buffer.alloc(32, 9), { mode: 0o600 });
    symlinkSync(target, link);
    expect(() => readEncryptionKey(link)).toThrow();
    expect(readEncryptionKey(target)).toEqual(Buffer.alloc(32, 9));
  });

  it("prefers systemd LoadCredential over an environment file reference", () => {
    const directory = root();
    const fallback = join(directory, "fallback.json");
    const systemd = join(directory, "dingtalk.json");
    writeFileSync(fallback, JSON.stringify({ clientId: "fallback", clientSecret: "fallback-secret" }), { mode: 0o600 });
    writeFileSync(systemd, JSON.stringify({ clientId: "systemd", clientSecret: "systemd-secret" }), { mode: 0o600 });
    const provider = new SecureDingTalkCredentialFileProvider({
      CREDENTIALS_DIRECTORY: directory,
      OMB_DINGTALK_CREDENTIAL_FILE: fallback,
    });
    expect(provider.load()).toEqual({ clientId: "systemd", clientSecret: "systemd-secret" });
  });
});
