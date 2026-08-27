import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OwnerCardActionBridge } from "../server/integrations/dingtalk/actions.ts";
import { DingTalkCardActionLedger } from "../server/integrations/dingtalk/action-ledger.ts";
import { EnvironmentDingTalkCredentialProvider, readDingTalkConfiguration } from "../server/integrations/dingtalk/config.ts";
import { DingTalkSessionReplyRegistry } from "../server/integrations/dingtalk/reply-router.ts";
import { stableIdentifierHash } from "../server/integrations/dingtalk/safe-log.ts";
import { DingTalkStreamAdapter } from "../server/integrations/dingtalk/stream-adapter.ts";
import { RealDingTalkStreamSdk } from "../server/integrations/dingtalk/stream-sdk.ts";
import { startCollaborationService } from "../server/collaboration/service.ts";

const configuration = readDingTalkConfiguration();
if (configuration.state !== "ready") {
  console.error(JSON.stringify({ smoke: "dingtalk-stream", state: configuration.state, configured: false }));
  process.exitCode = 2;
} else if (process.env.OMB_DINGTALK_SMOKE_ALLOW_SEND === "1") {
  console.error(JSON.stringify({ smoke: "dingtalk-stream", state: "needs_configuration", code: "send_smoke_not_configured" }));
  process.exitCode = 2;
} else {
  const credentials = new EnvironmentDingTalkCredentialProvider().load();
  if (!credentials) throw new Error("dingtalk_credentials_unavailable");
  const dataDirectory = process.env.OMB_DINGTALK_SMOKE_DATA_DIR?.trim() || join(tmpdir(), "openmausbot-dingtalk-smoke");
  mkdirSync(dataDirectory, { recursive: true });
  const service = startCollaborationService({ dataDirectory });
  const sessions = new DingTalkSessionReplyRegistry();
  const actionLedger = new DingTalkCardActionLedger(join(dataDirectory, "dingtalk-card-actions.sqlite"));
  const sdk = new RealDingTalkStreamSdk(credentials);
  const adapter = new DingTalkStreamAdapter(
    sdk,
    { ingest: (message) => service.ingestDingTalkMessage(message) },
    new OwnerCardActionBridge((input) => service.performOwnerAction(input), actionLedger),
    sessions,
    {
      write(event) {
        console.info(JSON.stringify({
          smoke: "dingtalk-stream",
          ...event,
          ...(event.workItemId ? { workItemHash: stableIdentifierHash(event.workItemId) } : {}),
          workItemId: undefined,
        }));
      },
    },
  );
  const state = await adapter.start();
  console.info(JSON.stringify({ smoke: "dingtalk-stream", state, configured: true, mode: "receive-only" }));
  const shutdown = () => {
    adapter.stop();
    actionLedger.close();
    service.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
