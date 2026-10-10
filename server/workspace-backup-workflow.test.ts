import { expect, it } from "vitest";
import { verifyWorkspaceBackup } from "../scripts/verify-workspace-backup.ts";

it("restores an encrypted workspace through the real server and continues its original chat", async () => {
  const result = await verifyWorkspaceBackup();
  console.info(JSON.stringify(result));
  expect(result).toMatchObject({
    ok: true, identicalIds: true, transcriptPreserved: true, conversationContinued: true,
    attachmentBytesPreserved: true, skillAndProfilePreserved: true, sourceCredentialsExcluded: true, destinationCredentialsUnchanged: true,
    clientStateAllowlisted: true, oldDataSafetyCopy: true,
  });
}, 150_000);
