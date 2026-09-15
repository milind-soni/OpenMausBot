// Renderer-only avatar checks against a disposable, fake-engine server.
import { launchVerificationServer } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
let ui: MountedPreview | undefined;
try {
  fixture = await launchVerificationServer();
  ui = await mountPreview(fixture, {
    entry: "/src/testing/avatar-motion.tsx",
    route: "/__avatar-motion.html",
    title: "Avatar motion — isolated fixture",
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally {
  try {
    await ui?.close();
  } finally {
    await fixture?.close();
  }
}
