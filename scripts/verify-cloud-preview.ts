// Real ComputerPanel + isolated fake-engine server, with only its cloud
// transport simulated. No Box account or user's app data is contacted.
// Run: node --experimental-strip-types scripts/verify-cloud-preview.ts
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  await runControlOmb(["new-bot", "--name", "Box Preview Test", "--url", fixture.info.url]);
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/cloud-preview.tsx", route: "/__cloud-preview.html", title: "Isolated Box Preview Test",
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
