import { describe, expect, it } from "vitest";
import { createCloudSendRoutes } from "./cloud-send.ts";

const handler = (messages: Array<{ role: string; text?: string }>, hasMore = false) => createCloudSendRoutes({
  appVersion: "0.1.117",
  bots: () => [{ id: "bot-00000001", threadId: "thread-0001", name: "Yuki", title: "", description: "", soul: "", tasks: [{ threadId: "thread-0001" }] } as never],
  messagesTail: () => ({ messages, hasMore }),
  skills: () => [],
  logins: { changes: () => [], get: () => null, onePasswordConnectedAt: () => null, onePasswordGrants: () => ({}), onePasswordToken: () => null },
  config: () => ({}),
});
async function bots(route: ReturnType<typeof createCloudSendRoutes>): Promise<string[]> {
  let body: { items: Array<{ kind: string; label: string }> } | undefined;
  await route({ path: "/api/cloud-send", method: "GET", url: new URL("http://127.0.0.1/api/cloud-send"), res: { setHeader() {} }, json: (_res: unknown, _status: number, value: unknown) => { body = value as typeof body; } } as never);
  return body!.items.filter((item) => item.kind === "bot").map((item) => item.label);
}

describe("GET /api/cloud-send", () => {
  it("leaves out a starter that holds only its own greeting, and keeps a bot that was renamed, written to, or arrived without one", async () => {
    expect(await bots(handler([{ role: "bot", text: "Hi, I'm Yuki. What would you like me to do?" }]))).toEqual([]);
    expect(await bots(handler([{ role: "bot", text: "Hi, I'm Pearl. What would you like me to do?" }]))).toEqual(["Yuki"]);
    expect(await bots(handler([{ role: "bot", text: "Hi, I'm Yuki." }, { role: "user", text: "hello" }]))).toEqual(["Yuki"]);
    expect(await bots(handler([]))).toEqual(["Yuki"]);
    expect(await bots(handler([{ role: "bot", text: "Hi, I'm Yuki." }], true))).toEqual(["Yuki"]);
  });
});

describe("what a move asks of a server", () => {
  const PASSWORD = "fake-verify-Passw0rd";
  const ask = async (route: ReturnType<typeof createCloudSendRoutes>, path: string, method = "GET", body: unknown = undefined) => {
    let answered: { status: number; body: any } | undefined;
    await route({ path: path.split("?")[0], method, url: new URL(`http://127.0.0.1${path}`), req: {} as never, res: { setHeader() {} },
      json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => body } as never);
    return answered!;
  };
  const stored = { id: "l1", site: "example.test", hosts: ["accounts.example.test"], exactHost: false, username: "alice", password: PASSWORD, updatedAt: 5 };
  const withLogins = (cloudHome: boolean) => createCloudSendRoutes({
    appVersion: "0.1.120",
    bots: () => [{ id: "bot-00000001", threadId: "thread-0001", name: "Yuki", soul: "Be brief." } as never, { id: "bot-00000002", threadId: "thread-0002", name: "Kit", soul: "Plan." } as never],
    messagesTail: () => ({ messages: [], hasMore: false }), skills: () => [],
    logins: { changes: () => [stored], get: (id) => (id === "l1" ? stored as never : null), onePasswordConnectedAt: () => null, onePasswordGrants: () => ({}), onePasswordToken: () => null },
    config: () => ({}), cloudHome, connectionFingerprints: () => ({ "key:openrouter": "f".repeat(64) }),
  });

  it("one item's comparison, with its skills, to record it as soon as it went", async () => {
    const one = await ask(withLogins(false), "/api/cloud-send?item=bot%3Abot-00000002");
    expect(one.body.items.map((item: { key: string }) => item.key)).toEqual(["bot:bot-00000002"]);
    expect((await ask(withLogins(false), "/api/cloud-send")).body.items.filter((item: { kind: string }) => item.kind === "bot")).toHaveLength(2);
  });

  it("what only a move carries, only when a move asks", async () => {
    const routine = { id: "r1", name: "Morning", prompt: "Report.", target: "bot", botId: "bot-00000001", runOn: "maus", enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1] },
      durationMinutes: 15, nextRunAt: null, createdAt: 1, updatedAt: 1 };
    const route = createCloudSendRoutes({ appVersion: "0.1.120", bots: () => [{ id: "bot-00000001", threadId: "thread-0001", name: "Yuki", soul: "Be brief.", pinned: true } as never],
      messagesTail: () => ({ messages: [], hasMore: false }), skills: () => [], logins: { changes: () => [], get: () => null, onePasswordConnectedAt: () => null, onePasswordGrants: () => ({}), onePasswordToken: () => null },
      config: () => ({}), move: { dataDir: "/data", store: { bots: [], bot: () => undefined } as never, routines: () => ({ listRoutines: () => [routine], listRuns: () => [], adopt() {} }) as never,
        calls: () => null, webhooks: () => null, appEvents: () => null, claudeCodeSkills: () => [], instanceExists: () => true, owner: () => null,
        teamMemory: { list: () => [], adopt: () => 0 } as never, aboutMe: () => "", saveAboutMe() {} } });
    const sent = (await ask(route, "/api/cloud-send")).body.items;
    expect(sent.map((item: { key: string }) => item.key)).not.toContain("routine:r1");
    expect(sent.find((item: { kind: string }) => item.kind === "bot").parts.pinned).toBeUndefined();
    const moved = (await ask(route, "/api/cloud-send?move=1")).body.items;
    expect(moved.map((item: { key: string }) => item.key)).toContain("routine:r1");
    expect(moved.find((item: { kind: string }) => item.kind === "bot").parts.pinned).toMatch(/^[a-f0-9]{24}$/u);
  });

  it("fingerprints of the credentials, only on a Cloud home, under the asker's nonce, never a secret", async () => {
    const nonce = "n".repeat(43);
    expect((await ask(withLogins(false), "/api/cloud-send/verify-secrets", "POST", { nonce })).status, "this computer answers only over its private port").toBe(404);
    expect((await ask(withLogins(true), "/api/cloud-send/verify-secrets", "POST", { nonce: "short" })).status).toBe(400);
    const answered = await ask(withLogins(true), "/api/cloud-send/verify-secrets", "POST", { nonce });
    expect(answered.status).toBe(200);
    expect(Object.keys(answered.body.secrets).sort()).toEqual(["key:openrouter", "login:example.test|alice"]);
    expect(JSON.stringify(answered.body)).not.toContain(PASSWORD);
    const other = await ask(withLogins(true), "/api/cloud-send/verify-secrets", "POST", { nonce: "m".repeat(43) });
    expect(other.body.secrets["login:example.test|alice"]).not.toBe(answered.body.secrets["login:example.test|alice"]);
  });
});
