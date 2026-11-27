// Real Grok CLI, disposable HOME, synthetic pixels and a loopback model only.
// No subscription login, real provider request, or live OMB data is involved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const cli = resolve(process.argv[2] ?? "/opt/homebrew/bin/grok");
const home = mkdtempSync(join(tmpdir(), "omb-grok-images-"));
// Valid 32×32 PNG: Grok requires >=8 pixels per axis and >=512 pixels total.
const pixels = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGP4YKNBU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAA+GUEwTofF+AAAAAElFTkSuQmCC";
let sawImage = false;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
  const payload = JSON.parse(body);
  sawImage ||= payload.messages?.some((m: { content?: unknown }) => Array.isArray(m.content) && m.content.some((c: {type?: string; image_url?: {url?: string}}) => c.type === "image_url" && c.image_url?.url === `data:image/png;base64,${pixels}`)) === true;
  const response = { id: "fixture", created: 0, object: "chat.completion", model: "fixture", choices: [{index:0, message:{role:"assistant", content:"fixture image received"}, finish_reason:"stop"}], usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} };
  if (!payload.stream) { res.writeHead(200, {"Content-Type":"application/json"}).end(JSON.stringify(response)); return; }
  res.writeHead(200, {"Content-Type":"text/event-stream"});
  res.end(`data: ${JSON.stringify({...response, object:"chat.completion.chunk", choices:[{index:0,delta:{role:"assistant",content:"fixture image received"},finish_reason:null}]})}\n\ndata: ${JSON.stringify({...response,object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const port = (server.address() as {port:number}).port;
mkdirSync(join(home, ".grok"));
writeFileSync(join(home, ".grok", "config.toml"), `[cli]\nauto_update = false\n[models]\ndefault = "fixture"\n[model.fixture]\nmodel = "fixture"\nname = "Offline fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\napi_backend = "chat_completions"\napi_key = "fixture-not-a-secret"\n`);
const child = spawn(cli, ["--no-auto-update", "-m", "fixture", "agent", "stdio"], { cwd:home, env:{HOME:home, USERPROFILE:home, PATH:process.env.PATH, GROK_HOME:join(home,".grok")}, stdio:["pipe","pipe","pipe"] });
child.stderr.resume();
const lines = createInterface({input:child.stdout});
let id = 0;
const pending = new Map<number, {resolve:(result:any)=>void; reject:(error:Error)=>void}>();
lines.on("line", line => {
  try {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  } catch { /* startup notices are not protocol replies */ }
});
const request = (method:string, params:unknown) => new Promise<any>((resolve, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 20_000);
  pending.set(requestId,{resolve:(result)=>{clearTimeout(timer);resolve(result);},reject:(error)=>{clearTimeout(timer);reject(error);}});
  child.stdin.write(JSON.stringify({jsonrpc:"2.0", id:requestId,method,params})+"\n");
});
try {
  const init = await request("initialize",{protocolVersion:1,clientCapabilities:{}});
  assert.equal(init._meta?.grokShell, true, "Compatibility exception is specific to the official Grok runtime");
  const session = await request("session/new",{cwd:home,mcpServers:[]});
  await request("session/set_config_option",{sessionId:session.sessionId,configId:"model",value:"fixture"});
  await request("session/prompt",{sessionId:session.sessionId,prompt:[{type:"text",text:"Describe this image. Do not use tools."},{type:"image",data:pixels,mimeType:"image/png"}]});
  assert.equal(sawImage,true,"Grok must deliver exact image pixels to the model endpoint");
  console.log(JSON.stringify({ok:true,version:init._meta?.agentVersion,advertisedImages:init.agentCapabilities?.promptCapabilities?.image,pixelsDelivered:true}));
} finally {
  lines.close();
  child.kill();
  await new Promise<void>(done => { if(child.exitCode!==null || child.signalCode!==null) done(); else child.once("close",()=>done()); });
  server.closeAllConnections();
  await new Promise<void>(done=>server.close(()=>done()));
  rmSync(home,{recursive:true,force:true});
}
