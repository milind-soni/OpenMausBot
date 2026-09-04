// A loopback OpenAI-compatible chat-completions server for verification.
//
// Speaks exactly the SSE shape pi-ai's openai-completions provider parses:
// `data: {json}` chunks with choices[0].delta.{content,reasoning_content,
// tool_calls}, a final chunk carrying finish_reason (the provider throws if
// a stream ends without one) and usage, then `data: [DONE]`.
//
// Modes, via env or the exported factory options:
//   FAKE_OPENAI_MODE   echo (default) | tool | reasoning | error | slow
//   FAKE_OPENAI_PORT   0 (default) = pick a free port; the chosen port is
//                      printed as JSON on stdout when run as a script.
//   FAKE_OPENAI_TOOL   the tool name `tool` mode calls (default echo). Set
//                      it to a mounted, namespaced tool so the call reaches
//                      the approval gate instead of failing as unknown.
// `tool` answers the FIRST call with a tool call to `echo` and any later
// call in the same process with text, so a two-step agent turn completes.
// Never listens beyond 127.0.0.1.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeOpenAIOptions {
  mode?: "echo" | "tool" | "reasoning" | "error" | "slow";
  port?: number;
  /** delay before the first chunk in `slow` mode. */
  delayMs?: number;
  /** the tool `tool` mode calls. */
  toolName?: string;
}

export interface FakeOpenAIServer {
  port: number;
  url: string;
  /** every request body received, in order. */
  requests: Array<{ model: string; messages: unknown[]; stream: boolean; tools?: unknown[] }>;
  close(): Promise<void>;
}

const sse = (res: ServerResponse, payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

export function startFakeOpenAI(options: FakeOpenAIOptions = {}): Promise<FakeOpenAIServer> {
  const mode = options.mode ?? (process.env.FAKE_OPENAI_MODE as FakeOpenAIOptions["mode"]) ?? "echo";
  const delayMs = options.delayMs ?? Number(process.env.FAKE_OPENAI_DELAY_MS ?? "3000");
  const toolName = options.toolName ?? process.env.FAKE_OPENAI_TOOL ?? "echo";
  const requests: FakeOpenAIServer["requests"] = [];
  let calls = 0;

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
    });

  const server: Server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake-model", name: "Fake model" }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(req)) as FakeOpenAIServer["requests"][number];
    requests.push(body);
    calls += 1;
    const lastUser = [...(body.messages as Array<{ role: string; content: unknown }>)].reverse().find((m) => m.role === "user");
    // pi-ai sends user content in array form; echo the text, not the JSON
    const content = lastUser?.content;
    const echoed = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content as Array<{ text?: string }>).map((part) => part.text ?? "").join("")
        : "";

    if (mode === "error") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "simulated upstream failure" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const id = `chatcmpl-${calls}`;
    const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      sse(res, { id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: null, ...extra }] });
    const finish = (finish_reason: "stop" | "tool_calls") =>
      sse(res, {
        id,
        object: "chat.completion.chunk",
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason }],
        usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
      });

    const send = () => {
      if (mode === "tool" && calls === 1) {
        // one tool call, split the way real providers split it: id + name
        // first, arguments as deltas after
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_fake_1", type: "function", function: { name: toolName, arguments: "" } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"from the fake"}' } }] });
        finish("tool_calls");
      } else {
        if (mode === "reasoning") {
          chunk({ role: "assistant", reasoning_content: "thinking about " });
          chunk({ reasoning_content: "the answer" });
        }
        const text = `fake says: ${echoed}`;
        chunk({ role: "assistant", content: text.slice(0, Math.ceil(text.length / 2)) });
        chunk({ content: text.slice(Math.ceil(text.length / 2)) });
        finish("stop");
      }
      res.write("data: [DONE]\n\n");
      res.end();
    };
    if (mode === "slow") setTimeout(send, delayMs);
    else send();
  });

  return new Promise((resolve) => {
    server.listen(options.port ?? Number(process.env.FAKE_OPENAI_PORT ?? "0"), "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// Run as a script: print the URL so a fixture launcher can pass it on.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  void startFakeOpenAI().then((s) => {
    process.stdout.write(`${JSON.stringify({ ok: true, url: s.url, port: s.port })}\n`);
  });
}
