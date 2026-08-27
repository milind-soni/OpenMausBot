import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type {
  DingTalkCredentialProvider,
  DingTalkCredentials,
} from "../../integrations/dingtalk/config.ts";

const MAX_CREDENTIAL_BYTES = 16 * 1024;

function validateSecureStat(stat: Stats): void {
  if (!stat.isFile()) throw new Error("credential_file_must_be_regular");
  if ((stat.mode & 0o177) !== 0) throw new Error("credential_file_permissions_must_be_0600");
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.uid !== uid && stat.uid !== 0) throw new Error("credential_file_owner_invalid");
  if (stat.size < 1 || stat.size > MAX_CREDENTIAL_BYTES) throw new Error("credential_file_size_invalid");
}

export function readSecureCredentialFile(path: string): Buffer {
  if (!isAbsolute(path)) throw new Error("credential_file_must_be_absolute");
  const descriptor = openSync(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    validateSecureStat(before);
    const value = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    validateSecureStat(after);
    if (before.dev !== after.dev || before.ino !== after.ino || value.length !== after.size) {
      value.fill(0);
      throw new Error("credential_file_changed_while_reading");
    }
    return value;
  } finally {
    closeSync(descriptor);
  }
}

export function systemdCredentialPath(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const directory = environment.CREDENTIALS_DIRECTORY?.trim();
  if (!directory || !isAbsolute(directory)) return null;
  return join(directory, name);
}

export function configuredCredentialPath(
  environmentName: string,
  systemdName: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  return systemdCredentialPath(systemdName, environment) ?? environment[environmentName]?.trim() ?? null;
}

export class SecureDingTalkCredentialFileProvider implements DingTalkCredentialProvider {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.environment = environment;
  }

  load(): DingTalkCredentials | null {
    const path = configuredCredentialPath("OMB_DINGTALK_CREDENTIAL_FILE", "dingtalk.json", this.environment);
    if (!path) return null;
    const raw = readSecureCredentialFile(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as unknown;
    } finally {
      raw.fill(0);
    }
    if (!parsed || typeof parsed !== "object") throw new Error("dingtalk_credential_file_invalid");
    const clientId = "clientId" in parsed && typeof parsed.clientId === "string" ? parsed.clientId.trim() : "";
    const clientSecret =
      "clientSecret" in parsed && typeof parsed.clientSecret === "string" ? parsed.clientSecret.trim() : "";
    if (!clientId || !clientSecret) throw new Error("dingtalk_credential_file_invalid");
    return { clientId, clientSecret };
  }
}

export function readEncryptionKey(path: string): Buffer {
  const raw = readSecureCredentialFile(path);
  try {
    if (raw.length === 32) return Buffer.from(raw);
    const encoded = raw.toString("utf8").trim();
    const decoded = /^[0-9a-f]{64}$/iu.test(encoded) ? Buffer.from(encoded, "hex") : Buffer.from(encoded, "base64");
    if (decoded.length !== 32) {
      decoded.fill(0);
      throw new Error("backup_key_must_be_32_bytes");
    }
    return decoded;
  } finally {
    raw.fill(0);
  }
}
