import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  await runControlOmb(["new-bot", "--name", "Pepper", "--url", fixture.info.url]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const bot = bots.find((entry: { name: string }) => entry.name === "Pepper");
  await api("PUT", "/api/config", { profile: { name: "Thread browser preview" } });
  await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { title: "Anki vocabulary deck" });
  const { project } = await api("POST", `/api/bots/${bot.id}/projects`, { name: "Research" });
  for (let index = 0; index < 10; index += 1) {
    await api("POST", `/api/bots/${bot.id}/tasks`, { title: `Recent conversation ${index + 1}` });
  }
  const archived = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Archived lesson notes" });
  await api("PATCH", `/api/bots/${bot.id}/tasks/${archived.task.threadId}`, { archivedAt: Date.now() });
  await api("POST", `/api/bots/${bot.id}/tasks`, { title: "A long conversation title about comparing vocabulary recordings and preparing a complete review", projectId: project.id });
  const { group } = await api("POST", "/api/groups", { name: "Launch team", memberIds: [bot.id] });
  for (let index = 0; index < 8; index += 1) {
    await api("POST", `/api/groups/${group.id}/tasks`, { title: `Room conversation ${index + 1}` });
  }
  ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__thread-browser.html", title: "Isolated thread browser" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, botId: bot.id, groupId: group.id }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
