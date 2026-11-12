// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { createQwenAudioOutput } from "@/lib/qwen-audio-output";

const path = "./QwenAudioOutputSettings";
const component = await import(/* @vite-ignore */ path).catch(() => ({}));
let host: HTMLDivElement;
let root: Root;
let release: (() => void) | undefined;
beforeEach(() => { setLocale("zh"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { flushSync(() => root.unmount()); release?.(); release = undefined; host.remove(); vi.restoreAllMocks(); });
function fixture(supported: boolean) {
  const outputs = [{ deviceId: "headset-fixture", label: "USB 耳机", kind: "audiooutput" }, { deviceId: "speaker-fixture", label: "桌面扬声器", kind: "audiooutput" }] as MediaDeviceInfo[];
  const media = Object.assign(new EventTarget(), { enumerateDevices: vi.fn(async () => outputs), selectAudioOutput: vi.fn(async () => outputs[0]) });
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  const output = createQwenAudioOutput({ supportsSinkId: () => supported, mediaDevices: () => media, storage: () => storage });
  const context = Object.assign(new EventTarget(), { sinkId: "", ...(supported ? { setSinkId: vi.fn(async (id: string) => { context.sinkId = id; }) } : {}) });
  const attached = output.attach(context);
  release = attached.release;
  expect(component.QwenAudioOutputSettings).toBeTypeOf("function");
  flushSync(() => root.render(createElement(component.QwenAudioOutputSettings, { controller: output })));
  return { output, context, media, storage, attached };
}
describe("Qwen output device controls", () => {
  it("recovers a browser-paused call even without output routing support", async () => {
    const { context, output, attached } = fixture(false);
    await attached.ready;
    const playback = Object.assign(context, { state: "interrupted", resume: vi.fn(async () => { playback.state = "running"; playback.dispatchEvent(new Event("statechange")); }) });
    flushSync(() => playback.dispatchEvent(new Event("statechange")));
    expect(host.textContent).toContain("浏览器暂停了通话音频");
    const button = host.querySelector<HTMLButtonElement>('[data-qwen-audio-resume]');
    expect(button).not.toBeNull();
    flushSync(() => button!.click());
    await vi.waitFor(() => expect(host.querySelector('[data-qwen-audio-resume]')).toBeNull());
    expect(playback.resume).toHaveBeenCalledOnce();
    expect(output.getSnapshot().active).toBe(true);
  });
  it("shows only the system default and honest system-routing guidance when setSinkId is absent", async () => {
    const { attached, media } = fixture(false);
    await attached.ready;
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="千问音频输出（此设备）"]')!;
    expect(select).not.toBeNull();
    expect([...select.options].map((option) => option.textContent)).toEqual(["系统默认"]);
    expect(host.textContent).toContain("此浏览器不能在网页切换听筒/扬声器，请用系统音频输出或连接耳机");
    expect(host.textContent).not.toContain("听筒模式");
    expect(host.querySelector("button")).toBeNull();
    expect(media.selectAudioOutput).not.toHaveBeenCalled();
  });
  it("uses actual browser device names and switches the active context from its select and chooser", async () => {
    const { output, context, media, storage, attached } = fixture(true);
    await attached.ready;
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="千问音频输出（此设备）"]')!;
    await vi.waitFor(() => expect([...select.options].map((option) => option.textContent)).toEqual(["系统默认", "USB 耳机", "桌面扬声器"]));
    flushSync(() => { select.value = "speaker-fixture"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(() => expect(context.setSinkId).toHaveBeenCalledExactlyOnceWith("speaker-fixture"));
    await vi.waitFor(() => expect(select.value).toBe("speaker-fixture"));
    flushSync(() => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(media.selectAudioOutput).toHaveBeenCalledExactlyOnceWith({ deviceId: "speaker-fixture" });
    await vi.waitFor(() => expect(select.value).toBe("headset-fixture"));
    expect(output.getSnapshot().active).toBe(true);
    expect(storage.setItem).toHaveBeenLastCalledWith("omb-qwen-audio-output", "headset-fixture");
    expect(host.textContent).toContain("仅保存在此设备的浏览器");
    expect(host.textContent).toContain("不是播放完成或审批凭据");
  });
  it("offers a real resume action when routing succeeds but the browser pauses playback", async () => {
    const { output, context, attached } = fixture(true);
    await attached.ready;
    const playback = Object.assign(context, { state: "suspended", resume: vi.fn(async () => { playback.state = "running"; }) });
    playback.resume.mockRejectedValueOnce(new DOMException("fixture", "NotAllowedError"));
    await output.select("headset-fixture");
    await vi.waitFor(() => expect(host.textContent).toContain("浏览器暂停了通话音频"));
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "恢复通话音频");
    expect(button).toBeDefined();
    flushSync(() => button!.click());
    await vi.waitFor(() => expect(output.getSnapshot().error).toBeNull());
    expect(playback.resume).toHaveBeenCalledTimes(2);
    expect(context.setSinkId).toHaveBeenCalledTimes(1);
    expect(output.getSnapshot().active).toBe(true);
  });
  it("retains the selected value and the live context on a denied route, without exposing raw errors", async () => {
    const { output, context, attached } = fixture(true);
    await attached.ready;
    await output.select("headset-fixture");
    await vi.waitFor(() => expect(host.querySelector<HTMLSelectElement>("select")!.value).toBe("headset-fixture"));
    context.setSinkId!.mockRejectedValueOnce(new DOMException("fixture private detail", "NotAllowedError"));
    const select = host.querySelector<HTMLSelectElement>("select")!;
    flushSync(() => { select.value = "speaker-fixture"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(() => expect(host.textContent).toContain("未获授权或已取消"));
    expect(select.value).toBe("headset-fixture");
    expect(host.textContent).not.toContain("fixture private detail");
    expect(output.getSnapshot().active).toBe(true);
  });
});
