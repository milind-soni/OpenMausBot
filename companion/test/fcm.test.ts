import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createFcmSender, parseFirebaseCredential } from "../src/fcm.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  format: "pem",
  type: "pkcs8",
}).toString();

const credential = {
  type: "service_account",
  project_id: "openmaus-chief",
  private_key: privateKey,
  client_email: "push@openmaus-chief.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

describe("FCM HTTP v1 sender", () => {
  it("rejects malformed or wrong-project credentials before network access", () => {
    expect(parseFirebaseCredential("not-json", "openmaus-chief")).toBeNull();
    expect(parseFirebaseCredential(JSON.stringify({ ...credential, project_id: "other" }), "openmaus-chief")).toBeNull();
    expect(parseFirebaseCredential(JSON.stringify(credential), "openmaus-chief")?.clientEmail).toBe(credential.client_email);
  });

  it("mints one OAuth token, sends data-only notifications, and reuses the token", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ name: "projects/openmaus-chief/messages/1" }), { status: 200 }));
    const sender = createFcmSender({ credential: JSON.stringify(credential), projectId: "openmaus-chief", fetch: fetchMock });
    const notification = {
      id: "stream-1:42",
      kind: "question",
      botId: "chief",
      botName: "Chief",
      threadId: "thread-7",
      title: "Chief has a question",
      body: "Approve the draft?",
    } as const;

    await expect(sender.send("device-token-abcdefghijklmnopqrstuvwxyz", notification)).resolves.toEqual({ kind: "delivered" });
    await expect(sender.send("device-token-abcdefghijklmnopqrstuvwxyz", notification)).resolves.toEqual({ kind: "delivered" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const messageRequest = fetchMock.mock.calls[1];
    expect(messageRequest[0]).toBe("https://fcm.googleapis.com/v1/projects/openmaus-chief/messages:send");
    expect(messageRequest[1]?.headers).toMatchObject({ authorization: "Bearer access-1" });
    const requestBody = JSON.parse(String(messageRequest[1]?.body));
    expect(requestBody.message).toEqual({
      token: "device-token-abcdefghijklmnopqrstuvwxyz",
      data: {
        id: "stream-1:42",
        kind: "question",
        botId: "chief",
        botName: "Chief",
        threadId: "thread-7",
        title: "Chief has a question",
        body: "Approve the draft?",
        avatarUrl: "",
      },
      android: { priority: "high" },
    });
  });

  it("classifies an unregistered device without disabling other targets", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 }));
    const sender = createFcmSender({ credential: JSON.stringify(credential), projectId: "openmaus-chief", fetch: fetchMock });

    await expect(sender.send("expired-device-token-abcdefghijklmnop", {
      id: "s:2",
      kind: "done",
      botId: "chief",
      botName: "Chief",
      threadId: "t",
      title: "Chief finished",
      body: "Done",
    })).resolves.toEqual({ kind: "invalid-target" });
  });

  it("treats a plain 404 from FID-based delivery as only that device becoming invalid", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 }));
    const sender = createFcmSender({ credential: JSON.stringify(credential), projectId: "openmaus-chief", fetch: fetchMock });

    await expect(sender.send("firebase-installation-id-123456", {
      id: "s:3",
      kind: "done",
      botId: "chief",
      botName: "Chief",
      threadId: "t",
      title: "Chief finished",
      body: "Done",
    })).resolves.toEqual({ kind: "invalid-target" });
  });
});
