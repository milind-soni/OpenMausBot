import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInkboxTunnelHandler, openInkboxTunnel } from "./inkbox-tunnel.ts";
it("forwards only signed POST /inkbox to the fixed local receiver", async () => {
  const calls: Array<{url:string; init?:RequestInit}> = [];
  const handler = createInkboxTunnelHandler({ handle:"maus-test", port:18880, active:()=>true,
    fetch:async (url,init)=>{calls.push({url:String(url),init}); return new Response(null,{status:202});} });
  const headers={"x-inkbox-request-id":"evt", "x-inkbox-timestamp":"123", "x-inkbox-signature":"sha256=abc", authorization:"secret", cookie:"private"};
  const response=await handler(new Request("https://maus-test.inkboxwire.com/inkbox",{method:"POST",headers,body:"{}"}));
  expect(response.status).toBe(202); expect(calls[0].url).toBe("http://127.0.0.1:18880/inkbox");
  const forwarded=new Headers(calls[0].init?.headers); expect(forwarded.get("authorization")).toBeNull(); expect(forwarded.get("cookie")).toBeNull();
  expect(forwarded.get("x-inkbox-request-id")).toBe("evt"); expect(calls[0].init?.redirect).toBe("error");
  for(const path of ["/api/config","/contacts/v1/requests","/inkbox?x=1","/inkbox/extra"])
    expect((await handler(new Request("https://maus-test.inkboxwire.com"+path,{method:"POST",headers,body:"{}"}))).status).toBe(404);
  expect(calls).toHaveLength(1);
});
it("refuses invalid origins, missing signatures, oversized bodies, and disconnected requests", async()=>{
  let active=true; let calls=0;
  const handler=createInkboxTunnelHandler({handle:"maus-test",port:18880,active:()=>active,fetch:async()=>{calls++;return new Response(null,{status:202})}});
  expect((await handler(new Request("https://evil.example/inkbox",{method:"POST"}))).status).toBe(404);
  expect((await handler(new Request("https://maus-test.inkboxwire.com/inkbox",{method:"POST"}))).status).toBe(403);
  const headers={"x-inkbox-request-id":"evt","x-inkbox-timestamp":"123","x-inkbox-signature":"sha256=abc"};
  expect((await handler(new Request("https://maus-test.inkboxwire.com/inkbox",{method:"POST",headers,body:"x".repeat(128*1024+1)}))).status).toBe(413);
  active=false;
  expect((await handler(new Request("https://maus-test.inkboxwire.com/inkbox",{method:"POST",headers,body:"{}"}))).status).toBe(503); expect(calls).toBe(0);
});
it("never releases loopback response bodies or provider failure details",async()=>{
  const headers={"x-inkbox-request-id":"evt","x-inkbox-timestamp":"123","x-inkbox-signature":"sha256=abc"};
  const handler=createInkboxTunnelHandler({handle:"maus-test",port:18880,active:()=>true,fetch:async()=>new Response("private local details",{status:500})});
  const result=await handler(new Request("https://maus-test.inkboxwire.com/inkbox",{method:"POST",headers,body:"{}"}));
  expect(result.status).toBe(503);expect(await result.text()).toBe("");
});

const identityId = "a1111111-1111-4111-8111-111111111111";
const tunnelId = "c1111111-1111-4111-8111-111111111111";
const tunnelMetadata = { id:tunnelId, tunnel_name:"maus-test", agent_identity_id:identityId, public_host:"maus-test.inkboxwire.com", tls_mode:"edge", status:"active", zone:"inkboxwire.com" };
const roots:string[]=[];
afterEach(()=>{ vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function sdkFixture(changed:Record<string,unknown>={}) {
  const stateDir=mkdtempSync(join(tmpdir(),"inkbox-sdk-test-"));roots.push(stateDir);
  const calls:Array<{url:string;init?:RequestInit}>=[];
  const fetcher:typeof fetch=async(url,init)=>{
    calls.push({url:String(url),init});
    if(String(url)==="https://inkbox.ai/api/v1/identities/maus-test") return Response.json({ id:identityId,agent_handle:"maus-test",status:"active",imessage_enabled:true,signing_key_configured:true,tunnel:tunnelMetadata });
    if(String(url)===`https://inkbox.ai/api/v1/tunnels/${tunnelId}`) return Response.json({...tunnelMetadata,currently_connected:false,...changed});
    // The old SDK asks its own unguarded transport for the list.
    if(String(url).endsWith("/tunnels/"))return Response.json([{...tunnelMetadata,currently_connected:false,...changed}]);
    throw new Error("Unexpected fixture URL");
  };
  vi.stubGlobal("fetch",fetcher);
  return {stateDir,calls, options:{apiKey:"synthetic-runtime",identityId,handle:"maus-test",stateDir,port:18880,active:()=>true,fetch:fetcher}};
}
it("drives the real SDK through fixed validated reads with no redirects or ambient configuration",async()=>{
  const f=sdkFixture();
  vi.stubEnv("INKBOX_BASE_URL","https://attacker.example");
  vi.stubEnv("INKBOX_VAULT_KEY","ambient-vault-key");
  const listener=await openInkboxTunnel(f.options);
  try {
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.every(call=>call.url.startsWith("https://inkbox.ai/api/v1/") && !call.url.includes("/api/v1/api/v1/"))).toBe(true);
    expect(f.calls.every(call=>call.init?.redirect==="error")).toBe(true);
    expect(JSON.parse(readFileSync(join(f.stateDir,"state.json"),"utf8"))).toMatchObject({tunnel_id:tunnelId,zone:"inkboxwire.com",public_host:"maus-test.inkboxwire.com"});
    expect(listener.isConnected).toBe(false);
  } finally { await listener.close(); }
});
it("rejects substituted, active, unknown, or mismatched real SDK tunnel metadata",async()=>{
  for(const changed of [{zone:"attacker.example"},{currently_connected:true},{currently_connected:null},{currently_connected:undefined},{agent_identity_id:tunnelId},{tls_mode:"passthrough"},{tunnel_name:"another-handle"},{public_host:"attacker.example"},{status:"deleted"}]) {
    const f=sdkFixture(changed);
    let accepted;
    try { accepted=await openInkboxTunnel(f.options); }
    catch { continue; }
    await accepted.close();
    expect.fail(`Accepted unsafe tunnel fields ${JSON.stringify(changed)}`);
  }
});
it("revalidates cached SDK state against the selected identity and bounds cached IDs",async()=>{
  const f=sdkFixture({agent_identity_id:tunnelId});
  writeFileSync(join(f.stateDir,"state.json"),JSON.stringify({tunnel_id:tunnelId,name:"other",zone:"attacker.example"}));
  await expect(openInkboxTunnel(f.options)).rejects.toThrow();
  writeFileSync(join(f.stateDir,"state.json"),JSON.stringify({tunnel_id:"../../api-keys",zone:"attacker.example"}));
  f.calls.length=0;
  await expect(openInkboxTunnel(f.options)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

it("rejects control-plane redirects through the actual SDK adapter",async()=>{
  const f=sdkFixture();
  const calls:RequestInit[]=[];
  f.options.fetch=async(_url,init)=>{calls.push(init!);return new Response(null,{status:302,headers:{Location:"https://attacker.example"}});};
  await expect(openInkboxTunnel(f.options)).rejects.toThrow();
  expect(calls).toHaveLength(1);expect(calls[0].redirect).toBe("error");
  expect(new Headers(calls[0].headers).get("X-API-Key")).toBe("synthetic-runtime");
});
it("rejects a stale SDK completion after disconnect during the last live read",async()=>{
  const f=sdkFixture();let active=true;let reads=0;
  const fetcher=f.options.fetch;
  f.options.active=()=>active;
  f.options.fetch=async(url,init)=>{
    const response=await fetcher(url,init);
    if(String(url).includes("/tunnels/") && ++reads===2) active=false;
    return response;
  };
  await expect(openInkboxTunnel(f.options)).rejects.toThrow();
});
