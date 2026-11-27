// The whole app as a new Cloud's owner sees it (scripts/verify-cloud-welcome.ts answers the session as one).
// ?desktop=1 adds the reduced bridge a Cloud's page gets in the desktop app; ?move=copy|done shows the one-time move on its
// way or landed; ?step= opens the welcome on a step; ?skin= picks a skin.
import { createRoot } from "react-dom/client";
import type { CloudSendNotice } from "../../electron/cloud-send.mjs";
import App from "../../src/App";
import { returnToWelcome } from "../../src/lib/cloud-welcome";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);

function installCloudPage(move: string | null) {
  const name = params.get("name") ?? "My Cloud";
  const sent = { bots: 6, updatedBots: 0, skills: 2, logins: 2, onePassword: true, settings: 1, chats: { conversations: 142, messages: 900 } };
  const notice: CloudSendNotice = {
    ready: true, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false,
    running: move === "copy", ...(move === "copy" ? { runningReason: "move", progress: { done: 34, total: 142 }, phase: "chats" as const } : {}),
    last: move === "done" ? { at: Date.now(), reason: "move", failed: 0, seen: false, sent } : null, whole: null,
    ...(move === "copy" ? { move: { phase: "copy" as const, chats: { done: 34, total: 142 } } } : {}),
    ...(move === "done" ? { move: { phase: "done" as const, counts: { bots: 6, skills: 2, logins: 2, onePassword: true, chats: 142, routines: 4 }, phone: true, held: [] } } : {}),
  };
  window.ogb = {
    platform: "darwin",
    getCapabilities: async () => initialDesktopCapabilities(),
    onCapabilitiesChanged: () => () => {},
    workspaces: { state: async () => ({ local: false, name, origin: location.origin, home: true }), menu: async () => {} },
    cloudSendPage: { notice: async () => notice, dismiss: async () => notice, onNotice: () => () => {} },
    cloudPlan: {
      state: async () => ({ status: "paid", tier: "pro", credit: { grantedUsd: 5, remainingUsd: 5, state: "active" } }),
      manage: async () => {},
    },
  } as unknown as typeof window.ogb;
}

if (params.get("desktop") === "1") installCloudPage(params.get("move"));
applySkin((params.get("skin") ?? "midnight") as SkinId);
const step = params.get("step");
if (step) returnToWelcome(step);
createRoot(document.getElementById("root")!).render(<App />);
