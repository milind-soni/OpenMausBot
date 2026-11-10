import { registerHooks } from "node:module";
import { join } from "node:path";

const home = process.env.HOME;
const target = process.env.OMB_TEST_QWEN_UPSTREAM;
if (!home || process.env.OMB_DATA_DIR !== join(home, ".openmausbot") || process.env.OMB_TEST_QWEN_STEERING !== "1"
  || !/^ws:\/\/127\.0\.0\.1:\d+$/.test(target ?? "") || !process.send) {
  throw new Error("The Qwen steering fixture requires an isolated home, loopback provider and IPC parent");
}
const server = new URL("../index.ts", import.meta.url).href;
const session = new URL("../qwen-live-session.ts", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    const source = String(result.source);
    if (url === session) {
      const anchor = "new QwenLiveSocket({ ...input, history,";
      if (source.split(anchor).length !== 2) throw new Error("Qwen upstream fixture seam changed");
      return { ...result, source: "import FixtureWebSocket from 'ws';\n" + source.replace(anchor,
        `new QwenLiveSocket({ ...input, history, upstream: new FixtureWebSocket(${JSON.stringify(target)}),`) };
    }
    if (url === server) return { ...result, source: source + `
process.on("message", (message) => {
  if (!message || message.fixture !== "qwen-steering") return;
  if (message.action === "continuation") {
    void startTurn(message.botId, message.text, { threadId: message.threadId, unattended: true, cardContinuation: true })
      .catch(error => process.send?.({ fixture: "qwen-steering", error: String(error) }));
  }
  process.send?.({ fixture: "qwen-steering", id: message.id,
    requestMessageId: directRequestOwners.get(message.threadId)?.messageId ?? null });
});
` };
    return result;
  },
});
