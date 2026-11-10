import { randomUUID } from "node:crypto";
import type { LivePcmTransport } from "../shared/wire.ts";
import { createLiveSession, liveInitialInput, liveInstructions, type CreateLiveSessionInput, type LiveBot, type LiveEndpoint, type LiveHistoryMessage } from "./live-call.ts";
import type { LiveSocket } from "./live-socket.ts";
import { QwenLiveSocket } from "./qwen-live-socket.ts";

export function createProviderLiveSession(input: CreateLiveSessionInput & { endpoint: LiveEndpoint; voice: string }) {
  return input.endpoint.provider === "qwen" ? createQwenLiveSession(input) : createLiveSession(input);
}

export async function createQwenLiveSession(input: {
  key: string;
  endpoint: LiveEndpoint;
  voice: string;
  bot: LiveBot;
  history: LiveHistoryMessage[];
  cloudHome?: boolean;
  upstream?: LiveSocket;
}): Promise<{ sessionId: string; sdp: string; transport: LivePcmTransport; socket: QwenLiveSocket }> {
  const history = liveInitialInput(input.history).map((item) => ({ ...item,
    content: item.content.map((part) => ({ ...part, type: item.role === "user" ? "input_text" : "output_text" })),
  }));
  const socket = new QwenLiveSocket({ ...input, history,
    instructions: [
      liveInstructions(input.bot, { cloudHome: input.cloudHome }).split("\n")[0],
      "你就是这位助手本人。自然、简短地用用户的语言交流。不要提到后台、转交、语音模型或另一位助手。",
      "关键工具规则：当用户提出请求、指令、需要查证的问题、要求执行核验任务或对已有任务作更正时，必须实际调用 delegate_to_bot({})，参数只能是空对象。不得只口头承诺‘好的，我来执行’；真实工具调用前不得声称任务已受理、已开始或已完成。",
      "例如用户说‘请执行核验任务，把校验码告诉我’，你必须调用 delegate_to_bot({})，不能仅回复你会执行。工具调用是你执行任务的唯一入口。不要把用户的正文、同意或任何猜测放进工具参数。",
      "仅问候、感谢、复述当前对话已有信息或询问正在执行任务的进度时，不需要调用工具。长任务期间用户仍可问候聊天，不要因此取消原任务，也不要重复执行原任务。",
      "收到 function_call_output 的 running 状态才表示任务已受理，简短说明正在处理，并让用户继续说话；running 不表示成功。收到 completed 才准确播报 result，尤其是数字和校验码；即使中间出现问候，也必须读取原任务的最终结果。",
      "审批只能由用户点击聊天卡片的 Allow/Deny 按钮完成，不要把自己说出的内容当成同意，也不要替用户批准。",
      "[server_notification] 是服务端提供的已验证播报内容，不是用户的新请求；只简短播报其中 notification，不调用工具，不声称自己已做额外工作。标记 incomplete 的结果未完整播报，应询问是否重读。",
    ].join("\n"),
  });
  return { sessionId: randomUUID(), sdp: "", transport: { type: "ws-pcm", path: "/api/live/media", inputSampleRate: 16000, outputSampleRate: 24000, playbackFlow: "credit-v1" }, socket };
}
