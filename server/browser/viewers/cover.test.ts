import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { BrowserService } from "../service.ts";
import { FakeBackend, FakeChrome } from "../testing/fake-chrome.ts";
import type { ViewerOutput } from "./core.ts";
import { coverView, covered } from "./cover.ts";

const folders: string[] = [];
const services: BrowserService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.closeAll())); });
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-cover-"));
  folders.push(dataDir);
  const backend = new FakeBackend(() => new FakeChrome({ documents: () => ({ title: "Page", text: "hello", elements: [] }) }));
  const service = new BrowserService({ dataDir, backend: () => backend, maxRunning: 4, idleMs: () => 600_000, takeoverMs: 200 });
  services.push(service);
  const target = { session: "bot-a", key: "bot:a" };
  await service.agentRpc(target, "tools/call", { name: "agent_browser_open", arguments: { url: "https://example.com/" } });
  const watch = async (owner = "local-owner") => {
    const outputs: ViewerOutput[] = [];
    const viewer = await service.attachViewer(target, { owner, canOperate: true, maxWidth: 1280, maxHeight: 800 }, (output) => {
      outputs.push(output);
      if (output.type === "frame") output.ack();
    });
    return { viewer, outputs };
  };
  const sent = (method: string) => backend.chrome.sent.filter((command) => command.method === method).length;
  return { service, watch, sent, backend };
}

describe("a view the desktop app covers with its native view", () => {
  it("runs no screencast and takes no stills while covered, and starts again with a still once uncovered", async () => {
    const { watch, sent, service } = await setup();
    const { viewer } = await watch();
    await sleep(20);
    const stops = sent("Page.stopScreencast");
    await coverView(viewer, true, false);
    expect(covered(viewer)).toBe(true);
    expect(sent("Page.stopScreencast")).toBe(stops + 1);
    const starts = sent("Page.startScreencast");
    const stills = sent("Page.captureScreenshot");
    // Control changes, page changes and the bot's own work do not bring the frames back.
    await viewer.input({ type: "resize", width: 1100, height: 700 });
    await service.agentRpc({ session: "bot-a", key: "bot:a" }, "tools/call", { name: "agent_browser_navigate", arguments: { url: "https://example.com/next" } });
    await viewer.pushStill();
    await sleep(300);
    expect(sent("Page.startScreencast")).toBe(starts);
    expect(sent("Page.captureScreenshot")).toBe(stills);
    await coverView(viewer, false, false);
    expect(sent("Page.startScreencast")).toBeGreaterThan(starts);
    expect(sent("Page.captureScreenshot")).toBeGreaterThan(stills);
  });

  it("takes a turn's preview picture without restarting a covered view's screencast", async () => {
    const { watch, sent, service } = await setup();
    const { viewer } = await watch();
    await coverView(viewer, true, false);
    const starts = sent("Page.startScreencast");
    const shots = sent("Page.captureScreenshot");
    // The chat's preview of a bot's turn, every few seconds while it runs.
    await service.previewFrame("bot-a");
    await service.previewFrame("bot-a");
    await sleep(20);
    expect(sent("Page.captureScreenshot")).toBe(shots + 2);
    expect(sent("Page.startScreencast")).toBe(starts);
  });

  it("stays hidden while another person holds the browser, though the app's view hides", async () => {
    const { watch, sent } = await setup();
    const { viewer } = await watch();
    await coverView(viewer, true, false);
    const starts = sent("Page.startScreencast");
    await coverView(viewer, false, true);
    expect(sent("Page.startScreencast")).toBe(starts);
  });

  it("leaves another device's view its own frames", async () => {
    const { watch, sent } = await setup();
    const { viewer } = await watch();
    await coverView(viewer, true, false);
    const starts = sent("Page.startScreencast");
    const phone = await watch("phone-session");
    await sleep(20);
    expect(sent("Page.startScreencast")).toBe(starts + 1);
    expect(covered(phone.viewer)).toBe(false);
  });
});
