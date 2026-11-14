import skins from "./skin-overlay.cjs";

export const ISLAND_LABELS = Object.freeze({
  idle: "Pronto para ajudar", listening: "Ouvindo…", thinking: "Trabalhando…", reply: "Resposta", error: "Não foi possível concluir",
  expand: "Expandir ilha", collapse: "Recolher ilha", send: "Enviar", prompt: "O que você quer fazer?", voice: "Falar", stopVoice: "Finalizar fala",
  captureOn: "Pausar percepção", captureOff: "Ativar percepção", captureActive: "Tela acompanhada", capturePaused: "Tela pausada",
  omi: "Contexto do Omi", omiReady: "Conectado", omiOff: "Não conectado", omiLoading: "Atualizando…", omiError: "Não foi possível atualizar",
  omiKey: "Chave de desenvolvedor do Omi", connect: "Conectar Omi", disconnect: "Desconectar", refresh: "Atualizar", configure: "Configurar Omi",
  cancel: "Cancelar tarefa", openChat: "Abrir conversa", closeSettings: "Fechar configuração", context: "Contexto recente",
});

export const ISLAND_SIZE = Object.freeze({ compactWidth: 380, compactHeight: 52, expandedWidth: 480, expandedHeight: 456 });

/** Sandboxed page. The preload exposes only window.island's named commands; context is always rendered as text. */
export function dynamicIslandHtml(iconBase64 = "") {
  const dark = skins.skinChrome("midnight"), light = skins.skinChrome("daylight");
  const icon = /^[A-Za-z0-9+/=]*$/.test(iconBase64) ? iconBase64 : "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Ilha MausBot</title><style>
:root{color-scheme:dark;--panel:${dark.color};--ink:${dark.symbolColor};--edge:color-mix(in srgb,var(--ink) 20%,transparent);--hover:color-mix(in srgb,var(--ink) 10%,transparent);--focus:var(--ink)}
body.light{color-scheme:light;--panel:${light.color};--ink:${light.symbolColor}}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--ink);font:13px/18px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;overflow:hidden}
button,input{font:inherit;color:inherit}button{cursor:pointer;border:1px solid var(--edge);background:transparent;border-radius:999px;min-height:32px;padding:4px 12px;white-space:nowrap;transition:background 120ms ease}button:hover{background:var(--hover)}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
[hidden]{display:none!important}#island{background:var(--panel);border:1px solid var(--edge);border-radius:0 0 24px 24px;overflow:hidden;height:52px}body.expanded #island{height:456px;border-radius:0 0 24px 24px}
#bar{height:50px;display:flex;align-items:center;padding:8px 16px;gap:12px}#brand{display:flex;align-items:center;gap:8px;min-width:0;flex:1;border:0;text-align:start;padding:0}#brand img{height:24px;width:24px;object-fit:contain}#brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#indicator{width:8px;height:8px;border-radius:50%;background:var(--ink);opacity:.3;flex:none}body.capturing #indicator,body.listening #indicator{opacity:1}body.listening #indicator{animation:listen 1.2s ease-in-out infinite}
#details{height:404px;padding:4px 16px 16px;display:flex;flex-direction:column;gap:12px;overflow-y:auto}#status,#composer,#actions,#omi-row,#settings{flex-shrink:0}#status{display:flex;align-items:center;gap:8px;justify-content:space-between;font-size:12px}#capture-status{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#capture{font-size:12px;min-height:28px;padding:2px 8px}
#reply{flex:1;min-height:52px;overflow:auto;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}#context{font-size:12px;max-height:44px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}#composer{display:flex;gap:8px}#prompt{min-width:0;flex:1;border:1px solid var(--edge);background:transparent;border-radius:8px;padding:8px;min-height:36px}#send{background:var(--ink);color:var(--panel);border-color:transparent}#actions,#omi-row{display:flex;align-items:center;gap:8px}#actions button{font-size:12px;min-height:28px;padding:2px 8px}#open-chat{margin-inline-start:auto}#omi-state{font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#omi-row button{min-height:28px;font-size:12px;padding:2px 8px}
#settings{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--edge);padding-top:8px}#settings label{font-size:12px}#key-row{display:flex;gap:8px}#omi-key{min-width:0;flex:1;background:transparent;border:1px solid var(--edge);border-radius:8px;padding:8px}#settings-actions{display:flex;gap:8px}#settings-actions button{font-size:12px;min-height:28px;padding:2px 8px}#close-settings{margin-inline-start:auto}
@keyframes listen{50%{opacity:.35}}@media(prefers-reduced-motion:reduce){button{transition:none}body.listening #indicator{animation:none}}
</style></head><body><main id="island"><header id="bar"><button id="brand" type="button" aria-expanded="false" aria-controls="details"><img src="data:image/png;base64,${icon}" alt="" ${icon ? "" : "hidden"}><span id="label">MausBot</span></button><span id="indicator" aria-hidden="true"></span><button id="voice" type="button"></button></header><section id="details" hidden><div id="status"><span id="capture-status"></span><button id="capture" type="button" aria-pressed="false"></button></div><p id="reply" role="status" aria-live="polite" dir="auto"></p><div id="context" dir="auto" hidden></div><form id="composer"><input id="prompt" type="text" maxlength="4000" autocomplete="off" dir="auto"><button id="send" type="submit"></button></form><div id="actions"><button id="cancel" type="button" hidden></button><button id="open-chat" type="button"></button></div><div id="omi-row"><span id="omi-state" role="status"></span><button id="refresh" type="button" hidden></button><button id="configure" type="button" aria-expanded="false" aria-controls="settings"></button></div><section id="settings" hidden><label id="key-label" for="omi-key"></label><div id="key-row"><input id="omi-key" type="password" autocomplete="off" spellcheck="false"><button id="connect" type="button"></button></div><div id="settings-actions"><button id="disconnect" type="button" hidden></button><button id="close-settings" type="button"></button></div></section></section></main><script>
const DEFAULT_LABELS=${JSON.stringify(ISLAND_LABELS)}, SIZE=${JSON.stringify(ISLAND_SIZE)};
const element=id=>document.getElementById(id);
let view={state:"idle",expanded:false,capture:{enabled:false},omi:{status:"disconnected"}}, labels=DEFAULT_LABELS;
const command=(name,...args)=>window.island?.[name]?.(...args);
const busy=()=>["thinking","sending","still-working"].includes(view.state);
function settings(open){element("settings").hidden=!open;element("configure").setAttribute("aria-expanded",String(open));if(!open)element("omi-key").value="";}
function render(next){
  view={...view,...next,capture:{...(next.capture||{})},omi:{...(next.omi||{})}};
  labels={...DEFAULT_LABELS,...next.labels};
  document.body.className=[view.theme==="light"?"light":"dark",view.expanded?"expanded":"",view.capture.enabled?"capturing":"",view.state==="listening"?"listening":""].join(" ");
  element("details").hidden=!view.expanded;
  element("brand").setAttribute("aria-expanded",String(Boolean(view.expanded)));
  element("brand").setAttribute("aria-label",view.expanded?labels.collapse:labels.expand);
  element("label").textContent=labels[view.state]||labels.idle;
  element("reply").textContent=String(view.text||"").slice(0,12000);
  element("voice").textContent=view.state==="listening"?labels.stopVoice:labels.voice;
  element("voice").setAttribute("aria-pressed",String(view.state==="listening"));
  element("voice").disabled=busy();
  element("capture-status").textContent=view.capture.message||(view.capture.enabled?labels.captureActive:labels.capturePaused);
  element("capture").textContent=view.capture.enabled?labels.captureOn:labels.captureOff;
  element("capture").setAttribute("aria-pressed",String(Boolean(view.capture.enabled)));
  element("prompt").setAttribute("aria-label",labels.prompt);element("prompt").placeholder=labels.prompt;
  element("send").textContent=labels.send;element("send").disabled=busy()||!element("prompt").value.trim();
  element("cancel").textContent=labels.cancel;element("cancel").hidden=!busy();
  element("open-chat").textContent=labels.openChat;
  const connected=["connected","ready","loading","error"].includes(view.omi.status)&&view.omi.configured!==false;
  const omiLabel=view.omi.status==="loading"?labels.omiLoading:view.omi.status==="error"?labels.omiError:connected?labels.omiReady:labels.omiOff;
  element("omi-state").textContent=labels.omi+" · "+omiLabel;
  element("omi-state").title=view.omi.message||omiLabel;
  element("refresh").textContent=labels.refresh;element("refresh").hidden=!connected;element("refresh").disabled=view.omi.status==="loading";
  element("configure").textContent=labels.configure;
  element("key-label").textContent=labels.omiKey;element("connect").textContent=labels.connect;
  element("disconnect").textContent=labels.disconnect;element("disconnect").hidden=!connected;
  element("close-settings").textContent=labels.closeSettings;
  element("context").textContent=String(view.contextSummary||"").slice(0,1000);element("context").hidden=!view.contextSummary;
  element("context").setAttribute("aria-label",labels.context);
  if(!view.expanded)settings(false);
  return {width:view.expanded?SIZE.expandedWidth:SIZE.compactWidth,height:view.expanded?SIZE.expandedHeight:SIZE.compactHeight};
}
element("brand").addEventListener("click",()=>command("toggleExpanded"));
element("capture").addEventListener("click",()=>command("toggleCapture"));
element("voice").addEventListener("click",()=>command("toggleVoice"));
element("cancel").addEventListener("click",()=>command("pause"));
element("open-chat").addEventListener("click",()=>command("openChat"));
element("refresh").addEventListener("click",()=>command("refreshOmi"));
element("configure").addEventListener("click",()=>settings(element("settings").hidden));
element("close-settings").addEventListener("click",()=>settings(false));
element("prompt").addEventListener("input",()=>{element("send").disabled=busy()||!element("prompt").value.trim()});
element("composer").addEventListener("submit",event=>{event.preventDefault();const text=element("prompt").value.trim();if(!text||busy())return;command("send",text.slice(0,4000));element("prompt").value="";element("send").disabled=true;});
element("connect").addEventListener("click",()=>{const key=element("omi-key").value.trim();if(!key)return;element("omi-key").value="";command("configureOmi",key);settings(false)});
element("disconnect").addEventListener("click",()=>{element("omi-key").value="";command("disconnectOmi");settings(false)});
document.addEventListener("keydown",event=>{if(event.key!=="Escape")return;if(!element("settings").hidden)settings(false);else if(view.expanded)command("toggleExpanded");});
render(view);
</script></body></html>`;
}
