import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeProxyAuth,
  encodeProxyAuth,
  forwardUrl,
  HostProxy,
  messageMatchesCompactNeedle,
  rewriteOpenAIMessages,
} from "./context-host-proxy.ts";
import { MID_TASK_CONTINUITY_SYSTEM } from "./context-compact.ts";

describe("rewriteOpenAIMessages", () => {
  const history = [
    { role: "system", content: "You are Wren." },
    { role: "user", content: "old task about billing" },
    { role: "assistant", content: "I will not touch billing." },
    { role: "user", content: "what is the vault path?" },
  ];

  it("keeps the bot/engine history out of the provider prompt", () => {
    const rewritten = rewriteOpenAIMessages(history, "Goal\nopen /secret/vault", "what is the vault path?");
    expect(rewritten[0]?.role).toBe("system");
    expect(String(rewritten[0]?.content)).toContain("You are Wren.");
    expect(String(rewritten[0]?.content)).toContain(MID_TASK_CONTINUITY_SYSTEM);
    expect(rewritten[1]).toEqual({
      role: "user",
      content: "Goal\nopen /secret/vault",
    });
    expect(rewritten.at(-1)).toEqual({ role: "user", content: "what is the vault path?" });
    expect(rewritten.some((m) => String(m.content).includes("billing"))).toBe(false);
  });

  it("splits as [system][user:vector][user:live ask] like the Grok compacted path", () => {
    const rewritten = rewriteOpenAIMessages(
      [{ role: "system", content: "You are Wren." }, { role: "user", content: "ancient" }, { role: "user", content: "live ask now" }],
      "Goal\nvault\nNext action\nreply canary",
      "live ask now",
    );
    expect(rewritten.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(rewritten[1]?.content).toBe("Goal\nvault\nNext action\nreply canary");
    expect(rewritten[2]?.content).toBe("live ask now");
    expect(String(rewritten[0]?.content)).toContain("Mid-task:");
  });

  it("does not treat a short later prompt as the compact turn because those words appeared in it", () => {
    const compactTurn =
      "Keep chatting test. Remember CANARY_OMB_TAIL_9C2E then stop. Do not continue CleanShot.";
    const afterRefresh = [
      { role: "system", content: "You are Wren." },
      { role: "user", content: "old billing" },
      { role: "user", content: compactTurn },
      { role: "assistant", content: "CANARY_OMB_TAIL_9C2E" },
      { role: "user", content: "stop" },
    ];
    const rewritten = rewriteOpenAIMessages(afterRefresh, "Goal\nHey bro", compactTurn);
    const contents = rewritten.map((m) => String(m.content));
    expect(messageMatchesCompactNeedle("stop", compactTurn)).toBe(false);
    expect(contents.some((c) => c.includes("old billing"))).toBe(false);
    expect(contents.some((c) => c.includes("CANARY_OMB_TAIL_9C2E"))).toBe(true);
    expect(contents.at(-1)).toBe("stop");
  });

  it("keeps later chat when the needle is the compacted user turn", () => {
    const afterRefresh = [
      { role: "system", content: "You are Wren." },
      { role: "user", content: "old billing thread" },
      { role: "assistant", content: "I will not touch billing." },
      { role: "user", content: "Read /tmp/omb-keep-chatting-pad.md and reply with the canary." },
      { role: "assistant", content: "CANARY_OMB_KEEP_CHATTING_7F3A\nvault=/tmp/omb-vault-7F3A" },
      { role: "user", content: "What is the canary code and the vault path?" },
    ];
    const rewritten = rewriteOpenAIMessages(
      afterRefresh,
      "Goal\nHey bro",
      "Read /tmp/omb-keep-chatting-pad.md and reply with the canary.",
    );
    const contents = rewritten.map((m) => String(m.content));
    expect(contents.some((c) => c.includes("old billing"))).toBe(false);
    expect(contents.some((c) => c.includes("CANARY_OMB_KEEP_CHATTING_7F3A"))).toBe(true);
    expect(contents.at(-1)).toBe("What is the canary code and the vault path?");
  });


  it("clips giant compact-turn paste for the provider while still matching the needle", () => {
    const pad = `GO4 UNIQUE-GO4 ${"ab".repeat(8_000)} CANARY_LIVE072_C495 vault=/tmp/omb-vault-live-072`;
    expect(pad.length).toBeGreaterThan(12_000);
    const messages = [
      { role: "system", content: "You are Wren." },
      { role: "user", content: "old billing thread" },
      { role: "assistant", content: "noted" },
      { role: "user", content: pad },
    ];
    const rewritten = rewriteOpenAIMessages(messages, "Goal\nkeep chatting", pad);
    const userTurns = rewritten.filter((m) => m.role === "user").map((m) => String(m.content));
    expect(userTurns[0]).toBe("Goal\nkeep chatting");
    expect(userTurns[0]).not.toMatch(/Current task state/i);
    expect(userTurns[1]!.length).toBeLessThan(2_000);
    expect(userTurns[1]).toMatch(/bulk paste omitted|clipped for refreshed context|GO4 UNIQUE-GO4/);
    expect(userTurns[1]).toContain("CANARY_LIVE072_C495");
    expect(userTurns[1]).toContain("/tmp/omb-vault-live-072");
    expect(userTurns.some((c) => c.includes("old billing"))).toBe(false);
    // full paste must not appear in provider messages
    expect(userTurns.some((c) => c.length > 5_000)).toBe(false);
  });


  it("leaves later giant pastes full so post-refresh fill can climb again", () => {
    const compactTurn = `GO4 UNIQUE-GO4 ${"ab".repeat(8_000)} CANARY_LIVE072_C495 vault=/tmp/omb-vault-live-072`;
    const laterPad = `UNIQUE-LATER ${"cd".repeat(8_000)} remember the canary`;
    expect(laterPad.length).toBeGreaterThan(12_000);
    const messages = [
      { role: "system", content: "You are Wren." },
      { role: "user", content: "old billing thread" },
      { role: "user", content: compactTurn },
      { role: "assistant", content: "ack" },
      { role: "user", content: laterPad },
    ];
    const rewritten = rewriteOpenAIMessages(messages, "Goal\nkeep chatting", compactTurn);
    const users = rewritten.filter((m) => m.role === "user").map((m) => String(m.content));
    // state + clipped compact turn + full later pad
    expect(users[0]).toBe("Goal\nkeep chatting");
    expect(users[0]).not.toMatch(/Current task state/i);
    expect(users[1]!.length).toBeLessThan(2_000);
    expect(users[1]).toMatch(/bulk paste omitted|clipped for refreshed context/);
    expect(users.at(-1)).toBe(laterPad);
    expect(users.at(-1)!.length).toBeGreaterThan(12_000);
  });

  it("keeps tool follow-ups after the current user turn", () => {
    const withTools = [
      ...history,
      { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
      { role: "tool", content: "ok", tool_call_id: "1" },
    ];
    const rewritten = rewriteOpenAIMessages(withTools, "Goal\nvault", "what is the vault path?");
    expect(rewritten.map((m) => m.role)).toEqual(["system", "user", "user", "assistant", "tool"]);
  });
});

describe("proxy auth", () => {
  it("round-trips a thread id through the bearer token", () => {
    const encoded = encodeProxyAuth("thread-1", "omlx");
    expect(decodeProxyAuth(`Bearer ${encoded}`)).toEqual({ threadId: "thread-1", apiKey: "omlx" });
    expect(decodeProxyAuth("Bearer sk-plain").threadId).toBeNull();
  });
});

describe("forwardUrl", () => {
  it("joins OpenAI-compat /v1 bases with /v1/chat/completions", () => {
    expect(forwardUrl("http://127.0.0.1:8080/v1", "/v1/chat/completions")).toBe(
      "http://127.0.0.1:8080/v1/chat/completions",
    );
    expect(forwardUrl("http://127.0.0.1:8080/v1", "/chat/completions")).toBe(
      "http://127.0.0.1:8080/v1/chat/completions",
    );
  });
});

describe("HostProxy", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rewrites the provider body and leaves the original request's last user turn", async () => {
    let seen: { messages?: Array<{ role: string; content: string }> } = {};
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        seen = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof seen;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      });
    });
    servers.push(upstream);
    const port = await new Promise<number>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => {
        const address = upstream.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    const proxy = new HostProxy();
    proxy.bind("t1", {
      targetBaseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "omlx",
      vector: "Goal\nvault",
      userText: "continue",
    });
    const base = await proxy.ensureListening();
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${encodeProxyAuth("t1", "omlx")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "ancient history" },
          { role: "assistant", content: "noted" },
          { role: "user", content: "continue" },
        ],
      }),
    });
    expect(response.ok).toBe(true);
    expect(seen.messages?.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(seen.messages?.[0]?.content).toContain(MID_TASK_CONTINUITY_SYSTEM);
    expect(seen.messages?.slice(1).map((m) => m.content)).toEqual(["Goal\nvault", "continue"]);
    expect(seen.messages?.some((m) => m.content === "ancient history")).toBe(false);
    await proxy.close();
  });
});
