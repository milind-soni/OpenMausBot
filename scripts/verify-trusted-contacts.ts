// Real Settings and HTTP routes in a disposable fake-engine workspace.
import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";
const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const { bot } = await api("POST", "/api/bots", { name: "Contact fixture" });
  await api("PATCH", "/api/config", { language: "en" });
  ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__trusted-contacts.html", title: "Isolated Mausbot trusted contacts" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, botId: bot.id }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
