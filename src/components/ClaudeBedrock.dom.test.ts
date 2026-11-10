// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "@/state/store";
import { ClaudeBedrockEndpoints } from "./ClaudeBedrock";

const bedrockInstance = () => ({
  instanceId: "claude-bedrock-fixture",
  driverKind: "claudeAgent",
  displayName: "Claude on Bedrock",
  access: "custom",
  snapshot: { state: "available" },
  models: { default: "", options: [] },
  claudeBedrock: {
    awsProfile: "default", awsRegion: "us-east-1", models: ["global.anthropic.claude-opus-5-5"],
    opusModel: "global.anthropic.claude-opus-5-5", sonnetModel: "", haikuModel: "", smallFastModel: "",
  },
}) as unknown as store.InstanceInfo;

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function mount(instances: store.InstanceInfo[]) {
  vi.spyOn(store, "useStore").mockReturnValue({
    state: { ...store.initialState, instances, bots: [] },
    dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
  } as unknown as ReturnType<typeof store.useStore>);
  flushSync(() => root.render(createElement(ClaudeBedrockEndpoints)));
}

function setValue(input: HTMLInputElement, value: string) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ instanceId: "new-id", instances: [] })));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("adding a Claude on Amazon Bedrock engine", () => {
  it("posts the profile, region and only the filled model fields, trimmed", async () => {
    mount([]);
    flushSync(() => host.querySelector<HTMLButtonElement>("button")!.click());
    const name = host.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    const profile = host.querySelector<HTMLInputElement>('input[aria-label="AWS profile"]')!;
    const region = host.querySelector<HTMLInputElement>('input[aria-label="AWS region"]')!;
    setValue(name, "  Team Bedrock  ");
    setValue(profile, " my-profile ");
    setValue(region, " us-west-2 ");
    const form = host.querySelector<HTMLFormElement>("form")!;
    await flushSync(() => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/instances/claude-bedrock");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      displayName: "Team Bedrock", awsProfile: "my-profile", awsRegion: "us-west-2",
      opusModel: "", sonnetModel: "", haikuModel: "", smallFastModel: "",
    });
  });

  it("clears a saved tier by sending an empty string for it on edit", async () => {
    mount([bedrockInstance()]);
    const editButton = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Edit");
    flushSync(() => editButton!.click());
    const opus = host.querySelector<HTMLInputElement>('input[aria-label="Opus model"]');
    expect(opus?.value).toBe("global.anthropic.claude-opus-5-5");
    setValue(opus!, "");
    const form = host.querySelector<HTMLFormElement>("form")!;
    await flushSync(() => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/instances/claude-bedrock-fixture/claude-bedrock");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(String(init.body));
    expect(body.opusModel).toBe("");
    expect(body.awsProfile).toBe("default");
  });
});
