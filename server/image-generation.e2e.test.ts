import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { startFakeImageApi, type FakeImageApi } from "./testing/fake-image-api.ts";

const botSchema = z.object({ bot: z.object({ id: z.string(), activeTaskId: z.string() }) });
const waitSchema = z.object({ status: z.string() });
const evidenceSchema = z.object({
  botId: z.string(),
  evidence: z.array(z.object({
    step: z.unknown().optional(),
    result: z.object({ tools: z.array(z.object({ name: z.string() })).optional() }).optional(),
    response: z.object({ result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ text: z.string() })) }) }).optional(),
  })),
});
const messagesSchema = z.object({
  messages: z.array(z.object({
    role: z.string(),
    text: z.string().optional(),
    attachments: z.array(z.object({ kind: z.string(), path: z.string(), mime: z.string() })).optional(),
  })),
});

interface ImageFixture {
  images: FakeImageApi;
  configure: (patch: unknown) => Promise<void>;
  newBot: (name: string) => Promise<z.infer<typeof botSchema>["bot"]>;
  ask: (bot: { id: string; activeTaskId: string }, text: string) => Promise<string>;
  savePlan: (plan: Record<string, unknown>) => void;
  turnOf: (botId: string) => z.infer<typeof evidenceSchema>;
  messages: (threadId: string) => Promise<z.infer<typeof messagesSchema>["messages"]>;
  savedImages: () => string[];
}

async function withImageFixture(test: (f: ImageFixture) => Promise<void>) {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } });
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url);
  const images = await startFakeImageApi();
  const dataDir = session.info.dataDir;
  const planPath = join(dataDir, "room-plan.json");
  try {
    await test({
      images,
      configure: async (patch) => { await api("/api/config", patch, "PUT"); },
      newBot: async (name) => botSchema.parse(await cli("new-bot", "--name", name)).bot,
      ask: async (bot, text) => {
        await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
        return waitSchema.parse(await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status;
      },
      savePlan: (plan) => writeFileSync(planPath, JSON.stringify(plan)),
      turnOf: (botId) => {
        const lines = existsSync(planPath + ".evidence.jsonl") ? readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").filter(Boolean) : [];
        const turn = lines.map((line) => evidenceSchema.parse(JSON.parse(line))).find((entry) => entry.botId === botId);
        if (!turn) throw new Error(`no scripted turn was recorded for ${botId}`);
        return turn;
      },
      messages: async (threadId) => messagesSchema.parse(await api("/api/threads/" + threadId + "/messages")).messages,
      savedImages: () => {
        const dir = join(dataDir, "attachments");
        return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".png")) : [];
      },
    });
  } finally {
    await images.stop();
    await session.close();
  }
}

const listedTools = (turn: z.infer<typeof evidenceSchema>) => turn.evidence[0]?.result?.tools?.map((tool) => tool.name) ?? [];

it("falls back from a keyless base to the backup and attaches the image to the settling reply", async () => withImageFixture(async (f) => {
  await f.configure({ imageGen: { primary: { provider: "openai" }, fallback: { provider: "custom", model: "fixture-image" }, customUrl: f.images.url } });
  const bot = await f.newBot("Image bot");
  f.savePlan({
    [bot.id]: {
      steps: [{ tool: "generate_image", arguments: { prompt: "a navy owl with a brass compass", aspect: "16:9" } }],
      reply: "Here is your owl.",
    },
  });
  expect(await f.ask(bot, "Make an image of a navy owl.")).toBe("settled");

  const turn = f.turnOf(bot.id);
  expect(listedTools(turn)).toContain("generate_image");
  const step = turn.evidence.find((entry) => entry.step)?.response?.result;
  expect(step?.isError).toBeFalsy();
  expect(step?.content[0]?.text).toContain("backup image provider, because the base failed: Add an OpenAI image API key first");

  expect(f.images.requests).toEqual([
    { model: "fixture-image", prompt: "a navy owl with a brass compass", response_format: "b64_json", size: "1536x1024", n: 1 },
  ]);

  const withImage = (await f.messages(bot.activeTaskId)).filter((m) => (m.attachments ?? []).some((a) => a.kind === "image"));
  expect(withImage).toHaveLength(1);
  expect(withImage[0]!.role).toBe("bot");
  expect(withImage[0]!.text).toBe("Here is your owl.");
  const image = withImage[0]!.attachments!.find((a) => a.kind === "image")!;
  expect(image.mime).toBe("image/png");
  const files = f.savedImages();
  expect(files).toHaveLength(1);
  expect(image.path.endsWith(files[0]!)).toBe(true);
}), 60_000);

it("hides generate_image from a bot when no image provider is set up", async () => withImageFixture(async (f) => {
  const bot = await f.newBot("No image bot");
  f.savePlan({ [bot.id]: { steps: [], reply: "No images here." } });
  expect(await f.ask(bot, "Make an image.")).toBe("settled");
  expect(listedTools(f.turnOf(bot.id))).not.toContain("generate_image");
  expect(f.images.requests).toEqual([]);
}), 60_000);
