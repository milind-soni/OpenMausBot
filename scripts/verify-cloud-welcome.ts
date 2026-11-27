// A new Cloud's welcome in the real app, on an isolated fake-engine server. Only what makes it a Cloud is
// answered here: the owner's session and config say cloudHome, and the engines list can carry the trial's
// Claude credit. POST /__fixture/engines?mode=credit|signed-in|signed-out picks the engines (credit by default).
// Run: node --experimental-strip-types scripts/verify-cloud-welcome.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { launchVerificationServer } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

type Mode = "credit" | "signed-in" | "signed-out";
let mode: Mode = "credit";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;

async function relay(req: IncomingMessage, res: ServerResponse, change: (body: Record<string, unknown>) => Record<string, unknown>) {
  const response = await fetch(`${fixture.info.url}${req.url}`, { headers: { accept: "application/json", cookie: req.headers.cookie ?? "" } });
  const body = await response.json() as Record<string, unknown>;
  res.statusCode = response.status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(response.ok ? change(body) : body));
}

function engines(body: Record<string, unknown>) {
  const instances = (body.instances as Array<Record<string, any>>).map((instance) => instance.driverKind === "claudeAgent"
    ? { ...instance, snapshot: { ...instance.snapshot, authenticated: mode === "signed-in" } } : instance);
  if (mode === "credit") instances.push({
    instanceId: "cloud-trial-credit", driverKind: "openai-compat", displayName: "Trial credit · Claude", readOnly: true, trialCredit: "active",
    snapshot: { state: "available" }, models: { default: "anthropic/claude-haiku-4.5", options: [{ id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" }] },
  });
  return { ...body, instances };
}

try {
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/cloud-welcome-preview.tsx", route: "/__cloud-welcome.html", title: "Isolated Cloud welcome",
    extraRoutes: [
      { path: "/api/auth/session", method: "GET", handler: (req, res) => relay(req, res, (body) => ({ ...body, cloudHome: true })) },
      { path: "/api/config", method: "GET", handler: (req, res) => relay(req, res, (body) => ({ ...body, cloudHome: true })) },
      { path: "/api/instances", method: "GET", handler: (req, res) => relay(req, res, engines) },
      { path: "/__fixture/engines", method: "POST", handler: (req, res) => {
        const asked = new URL(req.url ?? "/", "http://fixture").searchParams.get("mode");
        if (asked === "credit" || asked === "signed-in" || asked === "signed-out") mode = asked;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ mode }));
      } },
    ],
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
