// Actual Sidebar against a disposable fake-engine server; never the live app.
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  for (const name of ["Sidebar Atlas", "Sidebar Juniper"]) {
    await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  }
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/sidebar-preview.tsx", route: "/__sidebar-preview.html", title: "Isolated Sidebar Test",
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
