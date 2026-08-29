import { describe, expect, it, vi } from "vitest";

import {
  FIREBASE_PUSH_ENCRYPTION_KEY_FIELD,
  FIREBASE_SERVICE_ACCOUNT_FIELD,
  ensureFirebasePushEncryptionKey,
  firebaseCredentialEnv,
  importFirebaseServiceAccountFile,
  parseFirebaseServiceAccount,
} from "./firebase-credentials.mjs";

const ACCOUNT = {
  type: "service_account",
  project_id: "openmaus-chief",
  private_key_id: "key-id",
  private_key: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n",
  client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
  client_id: "123",
  token_uri: "https://oauth2.googleapis.com/token",
};

describe("Firebase desktop credentials", () => {
  it("generates one 32-byte push encryption key without mutating credentials", () => {
    const credentials = { xaiApiKey: "keep" };
    const result = ensureFirebasePushEncryptionKey(credentials, () => Buffer.alloc(32, 7));

    expect(result).toEqual({
      xaiApiKey: "keep",
      [FIREBASE_PUSH_ENCRYPTION_KEY_FIELD]: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(credentials).toEqual({ xaiApiKey: "keep" });
  });

  it("keeps a valid existing push encryption key stable", () => {
    const key = Buffer.alloc(32, 9).toString("base64");
    const credentials = { [FIREBASE_PUSH_ENCRYPTION_KEY_FIELD]: key };

    expect(ensureFirebasePushEncryptionKey(credentials, () => {
      throw new Error("should not rotate");
    })).toEqual(credentials);
  });

  it("passes only validated secrets to the companion environment", () => {
    const key = Buffer.alloc(32, 3).toString("base64");
    const serviceAccount = JSON.stringify(ACCOUNT);
    const env = firebaseCredentialEnv({
      [FIREBASE_PUSH_ENCRYPTION_KEY_FIELD]: key,
      [FIREBASE_SERVICE_ACCOUNT_FIELD]: serviceAccount,
    });

    expect(env).toEqual({
      OMB_PUSH_ENCRYPTION_KEY: key,
      OMB_FIREBASE_SERVICE_ACCOUNT_B64: Buffer.from(serviceAccount, "utf8").toString("base64"),
    });
  });

  it("accepts a service-account key but rejects client-only google-services.json", () => {
    expect(parseFirebaseServiceAccount(JSON.stringify(ACCOUNT))).toEqual(ACCOUNT);
    expect(() => parseFirebaseServiceAccount(JSON.stringify({
      project_info: { project_id: "openmaus-chief" },
      client: [{ client_info: { mobilesdk_app_id: "1:2:android:3" } }],
    }))).toThrow("service-account JSON");
  });

  it("imports through the encrypted credential update seam and returns no secret", async () => {
    const updateCredentials = vi.fn(async (derive) => derive({ existing: "keep" }));
    const result = await importFirebaseServiceAccountFile({
      filePath: "C:/Downloads/openmaus-service-account.json",
      readFile: async () => JSON.stringify(ACCOUNT),
      updateCredentials,
    });

    expect(result).toEqual({ configured: true, projectId: ACCOUNT.project_id });
    expect(updateCredentials).toHaveBeenCalledOnce();
    const saved = updateCredentials.mock.calls[0][0]({ existing: "keep" });
    expect(saved.existing).toBe("keep");
    expect(saved[FIREBASE_SERVICE_ACCOUNT_FIELD]).toBe(JSON.stringify(ACCOUNT));
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });

  it("does not touch encrypted credentials when the selected file is not a service account", async () => {
    const updateCredentials = vi.fn();
    await expect(importFirebaseServiceAccountFile({
      filePath: "C:/Downloads/google-services.json",
      readFile: async () => JSON.stringify({ project_info: { project_id: "openmaus-chief" } }),
      updateCredentials,
    })).rejects.toThrow("service-account JSON");
    expect(updateCredentials).not.toHaveBeenCalled();
  });
});
