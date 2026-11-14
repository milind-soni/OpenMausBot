import { randomUUID } from "node:crypto";
import { prepareIslandMessage } from "./island-context-message.mjs";

export function createIslandSession({ screenContext, omi, speech, server, request, render, openChat,
  allowed = () => true, prepareMessage = prepareIslandMessage }) {
  let state = "idle", text = "", expanded = false, controller = null, sink = null, chat = null;
  let disposed = false, listenTimer = null, cancelling = false, submittedChat = null, capturePreparation = null, omiError = null;
  async function abortable(promise, signal) {
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([promise, interrupted]); }
    finally { signal.removeEventListener("abort", abort); }
  }
  function repaint() {
    if (disposed) return;
    const capture = screenContext.snapshot();
    const omiView = omi.snapshot();
    render({ state, text, expanded,
      capture: { enabled: capture.active, lastCapturedAt: capture.lastCapturedAt,
        message: capture.error ? "Não foi possível ler a tela. Verifique a permissão de gravação." : undefined },
      omi: omiError ? { ...omiView, status: "error", message: omiError } : omiView,
      contextSummary: capture.active ? `${capture.frameCount} imagens recentes · enviadas somente com seu pedido` : "" });
  }
  function stopListening() {
    clearTimeout(listenTimer);
    const target = sink; sink = null;
    if (target) speech.stop(target);
  }
  function pauseCapture() {
    capturePreparation?.abort();
    screenContext.pause();
  }
  async function cancel() {
    if (disposed || cancelling) return;
    const active = controller;
    const targetChat = submittedChat;
    submittedChat = null;
    controller = null;
    active?.abort(); stopListening();
    state = "idle"; text = ""; repaint();
    if (!active || !targetChat) return;
    cancelling = true; state = "sending"; text = "Cancelando tarefa…"; repaint();
    try {
      await abortable(server.settleSend?.(), AbortSignal.timeout(10_000));
      const response = await request(`/api/bots/${encodeURIComponent(targetChat.botId)}/interrupt`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: targetChat.threadId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response?.ok) throw new Error("Interrupt refused");
      await response.body?.cancel().catch(() => {});
      state = "idle"; text = "";
    } catch {
      state = "error"; text = "Não foi possível confirmar o cancelamento. Abra a conversa para verificar a tarefa.";
    } finally { cancelling = false; repaint(); }
  }
  async function send(words) {
    if (disposed || controller || cancelling || typeof words !== "string" || !words.trim()) return;
    if (!allowed()) { state = "error"; text = "Use a ilha com os bots deste computador."; repaint(); return; }
    stopListening();
    const active = new AbortController(); controller = active; submittedChat = null;
    const prompt = words.trim().slice(0, 4000);
    state = "thinking"; text = prompt; expanded = true; repaint();
    const timeout = setTimeout(() => active.abort(), 180_000); timeout.unref?.();
    try {
      chat = await abortable(server.prepare(), active.signal);
      active.signal.throwIfAborted();
      const frames = screenContext.frames();
      const omiContext = omi.context();
      const capture = frames.length ? new AbortController() : null;
      capturePreparation = capture;
      let message;
      try {
        const preparationSignal = capture ? AbortSignal.any([active.signal, capture.signal]) : active.signal;
        try {
          message = await abortable(prepareMessage({ text: prompt, frames, omiContext, request, signal: preparationSignal }), preparationSignal);
        } catch (error) {
          if (!capture?.signal.aborted || active.signal.aborted) throw error;
        }
        if (capture?.signal.aborted) {
          message = await abortable(prepareMessage({ text: prompt, frames: [], omiContext, request, signal: active.signal }), active.signal);
        }
      } finally {
        if (capturePreparation === capture) capturePreparation = null;
      }
      active.signal.throwIfAborted();
      submittedChat = chat;
      const result = await server.ask({ chat, text: message, sendId: randomUUID(), signal: active.signal,
        onUpdate(update) {
          if (controller !== active || active.signal.aborted) return;
          if (update.kind === "reply") { text = update.text; repaint(); }
        } });
      if (controller !== active || active.signal.aborted) return;
      state = result === "failed" ? "error" : "reply";
      if (result === "needs-you") text += "\nAbra a conversa para continuar.";
    } catch {
      if (controller !== active) return;
      state = "error";
      text = active.signal.aborted ? "A espera terminou. Abra a conversa para verificar a tarefa." : "Não foi possível enviar. Verifique se o MausBot está pronto e tente novamente.";
    } finally {
      clearTimeout(timeout);
      if (controller === active) { controller = null; submittedChat = null; repaint(); }
    }
  }
  function toggleVoice() {
    if (disposed || controller || cancelling) return;
    if (sink) { speech.finish(sink); return; }
    if (speech.busy()) { state = "error"; text = "O microfone está em uso no MausBot."; repaint(); return; }
    let words = "";
    const target = {
      transcript(line) { if (sink !== target) return; words = String(line?.text ?? "").slice(0, 4000); text = words; repaint(); },
      replaced() { if (sink !== target) return; sink = null; clearTimeout(listenTimer); state = "idle"; repaint(); },
      end(info) {
        if (sink !== target) return;
        sink = null; clearTimeout(listenTimer);
        if (info?.code) { state = "error"; text = "Não foi possível ouvir. Verifique Microfone e Reconhecimento de Fala nos Ajustes do Sistema."; repaint(); }
        else if (words.trim()) void send(words);
        else { state = "idle"; text = ""; repaint(); }
      },
    };
    sink = target; state = "listening"; text = ""; expanded = true; repaint();
    listenTimer = setTimeout(() => { if (sink === target) speech.finish(target); }, 60_000);
    try { speech.start(target, { endpointMs: 1500 }); }
    catch { target.end({ code: 1 }); }
  }
  return {
    repaint, send, toggleVoice,
    toggleExpanded() { expanded = !expanded; repaint(); },
    toggleCapture() { if (screenContext.snapshot().active) pauseCapture(); else screenContext.start(); repaint(); },
    pause: cancel,
    openChat() { openChat(chat); },
    async refreshOmi() { await omi.refresh(); omiError = null; repaint(); },
    async configureOmi(key) {
      if (typeof key !== "string" || key.length > 4096) return;
      omiError = null;
      try { await omi.configure(key); }
      catch {
        omiError = "Não foi possível conectar o Omi. Verifique a chave e o chaveiro do Mac.";
        if (!controller && !cancelling) { state = "error"; text = omiError; }
      }
      repaint();
    },
    async disconnectOmi() {
      omiError = null;
      try { await omi.disconnect(); }
      catch {
        omiError = "Não foi possível remover a chave do Omi.";
        if (!controller && !cancelling) { state = "error"; text = omiError; }
      }
      repaint();
    },
    suspend() { pauseCapture(); stopListening(); if (state === "listening") { state = "idle"; text = ""; } repaint(); },
    dispose() { disposed = true; controller?.abort(); stopListening(); screenContext.dispose(); omi.dispose(); },
  };
}
