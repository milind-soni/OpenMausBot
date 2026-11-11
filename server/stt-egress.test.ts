import { afterEach, describe, expect, it, vi } from "vitest";

const undici = vi.hoisted(() => ({
  agents: [] as Array<{ connect?: { lookup?: unknown } }>,
  fetch: vi.fn(async (_url: string, _init?: RequestInit & { dispatcher?: unknown }) => new Response(JSON.stringify({ text: " heard on the Cloud ", data: [{ id: "whisper-1" }] }), { status: 200 })),
}));
vi.mock("undici", () => ({
  Agent: class { constructor(options: { connect?: { lookup?: unknown } }) { undici.agents.push(options); } },
  fetch: undici.fetch,
  FormData: globalThis.FormData,
}));

import type { AppConfig } from "./config.ts";
import { listSpeechModels, transcribe } from "./stt.ts";
import { refusingLookup, STT_CLOUD_HTTP_ERROR, STT_CLOUD_LINK_LOCAL_ERROR, SttAddressRefused, sttCloudRefusal, sttRefusalIn } from "./stt-egress.ts";

const config = (baseUrl: string): AppConfig => ({ stt: { provider: "openai", baseUrl, model: "whisper-1" } }) as AppConfig;
const AUDIO = new TextEncoder().encode("RIFF-fixture-audio");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  undici.fetch.mockClear();
});

describe("speech input addresses on a Cloud home", () => {
  it("refuses link-local and metadata addresses, however they are written", () => {
    for (const root of [
      "https://169.254.169.254/v1", "https://169.254.10.20/v1", "http://169.254.169.254/latest", "https://[fe80::1]/v1",
      "https://[fd00:ec2::254]/v1", "https://[::ffff:169.254.169.254]/v1", "https://2852039166/v1", "https://0251.0376.0251.0376/v1",
    ]) expect(sttCloudRefusal(root, true), root).not.toBeNull();
    expect(sttCloudRefusal("https://[fd00:ec2::254]/v1", true)).toBe(STT_CLOUD_LINK_LOCAL_ERROR);
  });

  it("sends plain http only to the Cloud machine itself", () => {
    for (const root of ["http://192.168.1.5:8000/v1", "http://whisper:8000/v1", "http://10.0.0.2/v1", "http://[fdaa::3]:8000/v1", "http://localhost.example.com/v1"]) {
      expect(sttCloudRefusal(root, true), root).toBe(STT_CLOUD_HTTP_ERROR);
    }
    for (const root of ["http://localhost:8000/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1", "https://api.groq.com/openai/v1", "https://stt.example.com/v1"]) {
      expect(sttCloudRefusal(root, true), root).toBeNull();
    }
  });

  it("leaves every address alone on a desktop or self-hosted server", () => {
    for (const root of ["http://169.254.169.254/v1", "http://192.168.1.5:8000/v1", "https://[fe80::1]/v1"]) expect(sttCloudRefusal(root, false), root).toBeNull();
  });

  it("refuses a name when any address it resolves to is link-local or metadata", async () => {
    const resolveTo = (addresses: string[]) => refusingLookup((_host, callback) => callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))));
    const run = (lookup: ReturnType<typeof refusingLookup>, all: boolean) => new Promise<{ error: Error | null; address?: unknown }>((resolve) =>
      lookup("stt.example.com", { all }, (error, address) => resolve({ error, address })));
    for (const addresses of [["169.254.169.254"], ["fd00:ec2::254"], ["203.0.113.7", "169.254.3.4"], ["fe80::5"], []]) {
      const { error } = await run(resolveTo(addresses), true);
      expect(error, addresses.join()).toBeInstanceOf(SttAddressRefused);
      expect(error?.message).toBe(STT_CLOUD_LINK_LOCAL_ERROR);
    }
    expect((await run(resolveTo(["203.0.113.7", "2001:db8::7"]), true)).address).toEqual([{ address: "203.0.113.7", family: 4 }, { address: "2001:db8::7", family: 6 }]);
    expect(await run(resolveTo(["203.0.113.7"]), false)).toEqual({ error: null, address: "203.0.113.7" });
  });

  it("finds a refusal that a failed fetch wrapped", () => {
    const refusal = new SttAddressRefused(STT_CLOUD_LINK_LOCAL_ERROR);
    expect(sttRefusalIn(new TypeError("fetch failed", { cause: refusal }))).toBe(refusal);
    expect(sttRefusalIn(new TypeError("fetch failed", { cause: new AggregateError([new Error("ECONNREFUSED"), refusal]) }))).toBe(refusal);
    expect(sttRefusalIn(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))).toBeNull();
  });
});

describe("speech input requests on a Cloud home", () => {
  it("sends no audio and asks for no models at a refused address", async () => {
    vi.stubEnv("OMB_CLOUD_ROLE", "personal");
    const sent = vi.fn();
    vi.stubGlobal("fetch", sent);
    await expect(transcribe(config("https://169.254.169.254/v1"), AUDIO, "audio/wav")).rejects.toThrow(STT_CLOUD_LINK_LOCAL_ERROR);
    await expect(listSpeechModels(config("http://[fd00:ec2::254]/v1"))).rejects.toThrow(STT_CLOUD_HTTP_ERROR);
    await expect(listSpeechModels(config("https://[fd00:ec2::254]/v1"))).rejects.toThrow(STT_CLOUD_LINK_LOCAL_ERROR);
    await expect(transcribe(config("http://192.168.1.5:8000/v1"), AUDIO, "audio/wav")).rejects.toThrow(STT_CLOUD_HTTP_ERROR);
    expect(sent).not.toHaveBeenCalled();
    expect(undici.fetch).not.toHaveBeenCalled();
  });

  it("sends audio and asks for models through a connection that checks every resolved address", async () => {
    vi.stubEnv("OMB_CLOUD_ROLE", "personal");
    const sent = vi.fn();
    vi.stubGlobal("fetch", sent);
    expect(await transcribe(config("https://stt.example.com/v1"), AUDIO, "audio/wav")).toBe("heard on the Cloud");
    expect(await listSpeechModels(config("http://localhost:8000/v1"))).toEqual(["whisper-1"]);
    expect(sent).not.toHaveBeenCalled();
    expect(undici.fetch.mock.calls.map(([url]) => url)).toEqual(["https://stt.example.com/v1/audio/transcriptions", "http://localhost:8000/v1/models"]);
    const init = undici.fetch.mock.calls[0]![1];
    expect(init?.dispatcher).toBeDefined();
    expect(init?.redirect).toBe("error");
    expect(undici.agents).toHaveLength(1);
    expect(typeof undici.agents[0]!.connect?.lookup).toBe("function");
  });

  it("refuses a name that resolves to the metadata service once the connection looks it up", async () => {
    vi.stubEnv("OMB_CLOUD_ROLE", "personal");
    undici.fetch.mockRejectedValueOnce(new TypeError("fetch failed", { cause: new SttAddressRefused(STT_CLOUD_LINK_LOCAL_ERROR) }));
    await expect(transcribe(config("https://metadata.example.com/v1"), AUDIO, "audio/wav")).rejects.toThrow(STT_CLOUD_LINK_LOCAL_ERROR);
  });

  it("keeps a home-network server working off the Cloud", async () => {
    const sent = vi.fn(async () => new Response(JSON.stringify({ text: "heard at home" }), { status: 200 }));
    vi.stubGlobal("fetch", sent);
    expect(await transcribe(config("http://192.168.1.5:8000/v1"), AUDIO, "audio/wav")).toBe("heard at home");
    expect(sent).toHaveBeenCalledOnce();
    expect(undici.fetch).not.toHaveBeenCalled();
  });
});
