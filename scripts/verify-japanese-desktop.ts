// Real visual acceptance in disposable Podman desktops, with no user data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const podman = process.env.OMB_VERIFY_PODMAN;
const machine = process.env.OMB_VERIFY_MACHINE;
const image = process.env.OMB_VERIFY_IMAGE;
if (!podman || !machine || !image) throw new Error("Set explicit OMB_VERIFY_PODMAN, OMB_VERIFY_MACHINE and OMB_VERIFY_IMAGE");
const output = resolve(process.env.OMB_VERIFY_OUTPUT || ".omb-scratch/japanese");
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "receipt.json"), JSON.stringify({ capturesComplete: false, visualReview: "pending" }, null, 2));
// Keep Podman's existing connection/SSH configuration, but isolate app imports.
const podmanEnv = { ...process.env };
const runtime = mkdtempSync(resolve(output, "runtime-"));
process.env.HOME = process.env.USERPROFILE = resolve(runtime, "home");
process.env.OMB_DATA_DIR = resolve(runtime, "app-data");
mkdirSync(process.env.HOME, { recursive: true });
try {
  await capture();
} finally {
  // runtime is an absolute, freshly created child of the evidence directory.
  assert(runtime.startsWith(resolve(output, "runtime-")));
  rmSync(runtime, { recursive: true, force: true });
}

async function capture() {
  const { containerRunArgs, perBotLocalVmTarget, CUA_EXECUTABLE, CUA_SOCKET } = await import("../server/container-computer.ts");
  const run = (args: string[]) => execFileSync(podman!, ["--connection", machine!, ...args], { env: podmanEnv, encoding: "utf8", timeout: 90_000 }).trim();
  const machineRun = (args: string[]) => execFileSync(podman!, ["machine", "ssh", machine!, ...args], { env: podmanEnv, encoding: "utf8", timeout: 90_000 }).trim();
  const driverEnv = ["-e", "DISPLAY=:1", "-e", "HOME=/home/cua", "-e", "CUA_DRIVER_INSTALL_CHANNEL=python_package", "-e", "CUA_DRIVER_RS_TELEMETRY_ENABLED=0"];
  const imageId = run(["image", "inspect", image!, "--format", "{{.Id}}"]);
  const localHtml = resolve(output, "index.html");
  writeFileSync(localHtml, '<!doctype html><meta charset="utf-8"><title>日本語の表示確認</title><h1>日本語の表示確認</h1><p>会社紹介・製品一覧・検証結果</p>');
  const records = [];
  for (const attempt of [1, 2]) {
    const workspace = machineRun(["mktemp", "-d", "/tmp/omb-font-XXXXXXXX"]);
    assert.match(workspace, /^\/tmp\/omb-font-[A-Za-z0-9]+$/);
    const target = { ...perBotLocalVmTarget(randomUUID()), containerName: `omb-font-fixture-${randomUUID()}`, workspaceDir: workspace };
    const args = containerRunArgs("podman", randomUUID(), target);
    // Separate known Firefox/Podman sandbox issue #853 is not this font patch.
    // Supply its prerequisite in the visual fixture only; production args stay unchanged.
    args.splice(args.length - 1, 0, "--cap-add", "SYS_CHROOT");
    args[args.length - 1] = imageId;
    try {
      run(args);
      run(["cp", localHtml, `${target.containerName}:/home/cua/workspace/index.html`]);
      run(["exec", "--user", "cua", ...driverEnv, target.containerName, "sh", "-c", "timeout 45 sh -c 'until xset q >/dev/null 2>&1; do sleep 1; done' && mkdir -p /tmp/font-proof-profile && { firefox-esr --no-remote --profile /tmp/font-proof-profile --width 1000 --height 700 file:///home/cua/workspace/index.html >/tmp/font-firefox.log 2>&1 & }"]);
      const font = run(["exec", "--user", "cua", target.containerName, "fc-match", ":lang=ja"]);
      // Use the bundled driver; optional X11 inspection utilities may be absent.
      const deadline = Date.now() + 45_000;
      for (;;) {
        let windows = "";
        try {
          windows = run(["exec", "--user", "cua", ...driverEnv, target.containerName, CUA_EXECUTABLE, "call", "list_windows", "{}", "--socket", CUA_SOCKET]);
        } catch { /* daemon may still be starting */ }
        if (windows.includes("日本語")) break;
        assert(Date.now() < deadline, "Japanese-titled Firefox window did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const state = run(["exec", "--user", "cua", ...driverEnv, target.containerName, CUA_EXECUTABLE, "call", "get_desktop_state", "{}", "--socket", CUA_SOCKET, "--screenshot-out-file", "/tmp/font-proof.png"]);
      const png = execFileSync(podman!, ["--connection", machine!, "exec", target.containerName, "cat", "/tmp/font-proof.png"], { env: podmanEnv, timeout: 90_000, maxBuffer: 12 * 1024 * 1024 });
      assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
      writeFileSync(resolve(output, `desktop-${attempt}.png`), png);
      writeFileSync(resolve(output, `state-${attempt}.json`), state);
      records.push({ attempt, image, imageId, font, screenshot: `desktop-${attempt}.png` });
      console.log(JSON.stringify(records.at(-1)));
    } finally {
      // Also remove a partially created container if podman run fails or times out.
      // Only remove its workspace after container removal succeeds.
      run(["rm", "-f", "--ignore", target.containerName]);
      machineRun(["rm", "-rf", "--", workspace]);
    }
  }
  writeFileSync(resolve(output, "receipt.json"), JSON.stringify({ capturesComplete: true, visualReview: "pending", records }, null, 2));
}
