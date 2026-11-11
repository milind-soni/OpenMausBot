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
const fixtureSteerAcks = new Map();
let fixtureSteerWrapped = false;
process.on("message", (message) => {
  if (!message || message.fixture !== "qwen-steering") return;
  if (message.action === "continuation") {
    void startTurn(message.botId, message.text, { threadId: message.threadId, unattended: true, cardContinuation: true })
      .catch(error => process.send?.({ fixture: "qwen-steering", error: String(error) }));
  }
  if (message.action === "hold-steer-ack") {
    const adapter = registry.get("steer")?.adapter;
    if (!adapter?.steer) throw new Error("The fixture requires a steering adapter");
    if (!fixtureSteerWrapped) {
      const steer = adapter.steer.bind(adapter);
      adapter.steer = async (threadId, text, images) => {
        const pending = fixtureSteerAcks.get(threadId);
        if (pending) pending.calls += 1;
        const outcome = await steer(threadId, text, images);
        if (pending?.hold) {
          pending.held = true;
          process.send?.({ fixture: "qwen-steering", event: "steer-ack-held", threadId, outcome });
          await pending.wait;
          pending.held = false;
          if (pending.fail) throw new Error("fixture steering acknowledgement lost");
        }
        return outcome;
      };
      fixtureSteerWrapped = true;
    }
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    fixtureSteerAcks.set(message.threadId, { hold: true, held: false, calls: 0, wait, release });
  }
  const pending = fixtureSteerAcks.get(message.threadId);
  if (message.action === "release-steer-ack" && pending) { pending.hold = false; pending.release(); }
  if (message.action === "lose-steer-ack" && pending) { pending.hold = false; pending.fail = true; pending.release(); }
  process.send?.({ fixture: "qwen-steering", id: message.id,
    requestMessageId: directRequestOwners.get(message.threadId)?.messageId ?? null,
    steerCalls: pending?.calls ?? 0, ackHeld: pending?.held ?? false });
});
` };
    return result;
  },
});
