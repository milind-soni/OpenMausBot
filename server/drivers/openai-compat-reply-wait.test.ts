import { afterEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ timeouts: [] as number[] }));
vi.mock("./openai-chat.ts", () => ({
  createOpenAIChatRuntime: (options: { timeoutMs: number }) => {
    runtime.timeouts.push(options.timeoutMs);
    return { adapter: {}, dispose: async () => {} };
  },
}));

const { OpenAICompatDriver } = await import("./openai-compat.ts");

afterEach(() => { vi.unstubAllEnvs(); runtime.timeouts = []; });

const create = (config: Record<string, unknown>) => OpenAICompatDriver.create({
  instanceId: "openai-compat-1", displayName: "Ollama", enabled: true,
  config: { url: "http://127.0.0.1:11434/v1", apiKeyEnv: "FIXTURE_KEY", ...config },
  environment: { FIXTURE_KEY: "synthetic-not-a-secret" },
});

it("waits as long as the server's own setting says, over the server-wide default", async () => {
  vi.stubEnv("OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS", "5000");
  await create({ replyWaitMinutes: 20 });
  await create({});
  vi.unstubAllEnvs();
  await create({});
  expect(runtime.timeouts).toEqual([20 * 60_000, 5_000, 180_000]);
});
