// Security: a paired phone's move writes bots and API keys into this computer. Only main's own dialog, which no page,
// server or phone can draw or answer, opens it, and it defaults to Don't Allow.
import { wordsIn } from "./lending-words.mjs";

// The packaged app ships the renderer's catalog only inside its page bundle, so main keeps these keys itself; a test holds
// them equal to src/locales.
const EN = Object.freeze({
  "moveIn.ask.one": "Your {device} wants to move {count} bot here. Allow?",
  "moveIn.ask.other": "Your {device} wants to move {count} bots here. Allow?",
  "moveIn.ask.detail": "Their chats, memory, skills and routines come too, with any API keys you picked on the phone. Nothing else here changes. The phone has 30 minutes to finish.",
  "moveIn.ask.allow": "Allow",
  "moveIn.ask.deny": "Don't Allow",
});

export const MOVE_IN_WORDS = Object.freeze({
  ...Object.fromEntries(["de", "es", "fr", "hi", "it", "ja", "ko", "pl", "ru", "tr", "uk", "vi"].map((code) => [code, EN])),
  "en": EN,
  "pt-br": Object.freeze({
    "moveIn.ask.one": "Seu {device} quer mover {count} bot para cá. Permitir?",
    "moveIn.ask.other": "Seu {device} quer mover {count} bots para cá. Permitir?",
    "moveIn.ask.detail": "As conversas, a memória, as habilidades e as rotinas vêm junto, com as chaves de API que você escolheu no celular. Nada mais muda aqui. O celular tem 30 minutos para terminar.",
    "moveIn.ask.allow": "Permitir",
    "moveIn.ask.deny": "Não permitir",
  }),
  "zh": Object.freeze({
    "moveIn.ask.one": "你的 {device} 想把 {count} 个机器人移到这里。允许吗？",
    "moveIn.ask.other": "你的 {device} 想把 {count} 个机器人移到这里。允许吗？",
    "moveIn.ask.detail": "它们的聊天、记忆、技能和例行任务会一起过来，还有你在手机上选的 API 密钥。这里的其他内容不会改变。手机有 30 分钟完成。",
    "moveIn.ask.allow": "允许",
    "moveIn.ask.deny": "不允许",
  }),
  "zh-tw": Object.freeze({
    "moveIn.ask.one": "你的 {device} 想把 {count} 個機器人移到這裡。要允許嗎？",
    "moveIn.ask.other": "你的 {device} 想把 {count} 個機器人移到這裡。要允許嗎？",
    "moveIn.ask.detail": "它們的聊天、記憶、技能和例行工作會一起過來，還有你在手機上選的 API 金鑰。這裡的其他內容不會改變。手機有 30 分鐘可以完成。",
    "moveIn.ask.allow": "允許",
    "moveIn.ask.deny": "不允許",
  }),
});

export function decodeMoveAsk(raw) {
  if (!raw || typeof raw !== "object" || raw.type !== "openmausbot:companion-move-ask") return null;
  const { deviceId, deviceName, bots, expiresAt } = raw;
  if (typeof deviceId !== "string" || !/^[\w-]{1,128}$/.test(deviceId)) return null;
  if (typeof deviceName !== "string" || !deviceName || deviceName.length > 80) return null;
  if (!Number.isInteger(bots) || bots < 1 || bots > 200) return null;
  if (!Number.isFinite(expiresAt)) return null;
  return { deviceId, deviceName, bots, expiresAt };
}

/** One dialog at a time. An answer counts only before its own ask expires, so a dialog left open never answers the
 * phone's next ask. */
export function createMoveInAsks({ dialog, locale, answer, now = Date.now }) {
  const show = async ({ deviceId, deviceName, bots, expiresAt }) => {
    if (now() >= expiresAt) return false;
    const words = wordsIn(MOVE_IN_WORDS, locale());
    const signal = AbortSignal.timeout(Math.ceil(expiresAt - now()));
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: words[bots === 1 ? "moveIn.ask.one" : "moveIn.ask.other"].replaceAll("{count}", String(bots)).replaceAll("{device}", () => deviceName),
      detail: words["moveIn.ask.detail"],
      buttons: [words["moveIn.ask.allow"], words["moveIn.ask.deny"]],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      signal,
    });
    // Electron 43 cannot close a message box without a parent window on macOS, so a click after expiry is checked here too.
    if (signal.aborted || now() >= expiresAt) return false;
    await answer(deviceId, response === 0);
    return response === 0;
  };
  let queue = Promise.resolve(false);
  return {
    ask(request) {
      queue = queue.then(() => show(request)).catch(() => false);
      return queue;
    },
  };
}
