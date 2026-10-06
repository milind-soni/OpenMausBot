import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { InkboxSetup } from "./inkbox-setup.ts";
const id="a1111111-1111-4111-8111-111111111111", botId="b1111111-1111-4111-8111-111111111111";
const roots:string[]=[];const setups:InkboxSetup[]=[];
afterEach(async()=>{await Promise.all(setups.splice(0).map(s=>s.close()));for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),"omb-inkbox-setup-")); roots.push(directory);
  let saved:any=null;let failSave=false;let scoped=false;let signing=false;let connectedElsewhere=false;let handle="maus-existing";
  const calls:Array<{path:string;method:string;key:string;body:any}>=[];let tunnelCloses=0;let tunnelOpens=0;
  let hook:((path:string)=>Promise<void>)|undefined;
  const identity=()=>({id,agent_handle:handle,status:"active",imessage_enabled:true,signing_key_configured:signing,tunnel:{id,tunnel_name:handle,agent_identity_id:id,status:"active",zone:"inkboxwire.com",public_host:`${handle}.inkboxwire.com`,tls_mode:"edge",currently_connected:connectedElsewhere}});
  const fetcher:typeof fetch=async(url,init)=>{
    const path=new URL(String(url)).pathname;await hook?.(path);
    const body=init?.body?JSON.parse(init.body as string):undefined;const apiKey=new Headers(init?.headers).get("X-API-Key")!;
    calls.push({path,method:init?.method??"GET",key:apiKey,body});
    if(path.endsWith("/api-keys/self"))return Response.json({status:"active",scoped_identity_id:scoped||apiKey==="runtime-key"?id:null});
    if(path==="/api/v1/identities" && init?.method==="POST"){handle=body.agent_handle;return Response.json(identity(),{status:201});}
    if(path==="/api/v1/identities")return Response.json([identity()]);
    if(path.startsWith("/api/v1/tunnels/"))return Response.json({...identity().tunnel,currently_connected:connectedElsewhere});
    if(path.startsWith("/api/v1/identities/"))return Response.json(identity());
    if(path==="/api/v1/api-keys")return Response.json({api_key:"runtime-key",record:{status:"active",scoped_identity_id:id}},{status:201});
    if(path===`/api/v1/webhooks/subscriptions/${id}`)return Response.json({id,agent_identity_id:id,url:`https://${handle}.inkboxwire.com/inkbox`,status:"active",event_types:body?.event_types??["imessage.received"]});
    if(path==="/api/v1/webhooks/subscriptions")return Response.json({id,agent_identity_id:id,url:body.url,event_types:body.event_types,signing_key:"signing-secret"},{status:201});
    if(path==="/api/v1/imessage/triage-number")return Response.json({number:"+15555550123",connect_command:`connect @${handle}`});
    throw new Error("Unexpected request");
  };
  let delivery:any[]=[];
  const make=()=>{
    const setup=new InkboxSetup({directory,port:18880,botExists:()=>true,
      secrets:{available:true,read:async()=>structuredClone(saved),write:async value=>{if(failSave)throw new Error("secret storage failure");saved=structuredClone(value);}},
      fetch:fetcher,makeChannel:()=>({handle:async()=>true,close:()=>{},idle:async()=>{},status:()=>({configured:true,deliveries:delivery})}),
      tunnel:async()=>{tunnelOpens++; let resolve!:()=>void; const waiting=new Promise<void>(r=>{resolve=r;});return{isConnected:true,wait:()=>waiting,close:async()=>{tunnelCloses++;resolve();}};},
    });setups.push(setup);return setup;
  };
  return {make,calls,get saved(){return saved},set failSave(v:boolean){failSave=v},set scoped(v:boolean){scoped=v},set signing(v:boolean){signing=v},set connectedElsewhere(v:boolean){connectedElsewhere=v},set hook(v:typeof hook){hook=v},set delivery(v:any[]){delivery=v},get opens(){return tunnelOpens},get closes(){return tunnelCloses}};
}
const input={apiKey:"admin-key",botId,ownerPhone:"+15555550199"};
it("provisions from one key, discards admin authority, and distinguishes readiness from phone proof",async()=>{
 const f=fixture(),s=f.make();await s.restore();await s.setup(input);
 expect(s.snapshot()).toMatchObject({phase:"awaiting_phone",botId,ownerPhone:input.ownerPhone,pairing:{number:"+15555550123"}});
 expect(f.saved.apiKey).toBe("runtime-key");expect(JSON.stringify(s.snapshot())).not.toMatch(/admin-key|runtime-key|signing-secret/);
 expect(f.calls.filter(c=>c.method==="POST").map(c=>c.path)).toEqual(["/api/v1/identities","/api/v1/api-keys","/api/v1/webhooks/subscriptions"]);
 expect(f.calls.find(c=>c.path.endsWith("subscriptions"))?.key).toBe("runtime-key");
 f.delivery=[{id:"received",sender:input.ownerPhone,status:"sent",reply:"hello"}];expect(s.snapshot().phase).toBe("connected");
});
it("restores encrypted configuration without repeating provider mutations",async()=>{
 const f=fixture(),s=f.make();await s.setup(input);await s.close();f.calls.length=0;
 const second=f.make();await second.restore();expect(second.snapshot().phase).toBe("awaiting_phone");
 expect(f.calls.every(c=>c.method==="GET")).toBe(true);expect(f.opens).toBe(2);
});
it("disconnect persists pause; reopening does not connect until explicitly resumed",async()=>{
 const f=fixture(),s=f.make();await s.setup(input);await s.disconnect();expect(s.snapshot().phase).toBe("disconnected");expect(f.saved.enabled).toBe(false);
 const second=f.make();await second.restore();expect(f.opens).toBe(1);await second.reconnect();expect(f.opens).toBe(2);
});
it("never provisions if encrypted storage cannot save",async()=>{
 const f=fixture();f.failSave=true;const s=f.make();await expect(s.setup(input)).rejects.toThrow("secure");expect(f.calls).toHaveLength(0);
});
it("refuses an already secured scoped identity without changing keys or subscriptions",async()=>{
 const f=fixture();f.scoped=true;f.signing=true;const s=f.make();await expect(s.setup(input)).rejects.toThrow("signing key");expect(f.calls.every(c=>c.method==="GET")).toBe(true);
});
it("disconnect wins while setup is awaiting a provider read",async()=>{
 const f=fixture();let release!:()=>void;let entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});
 f.hook=async path=>{if(path.endsWith("/api-keys/self")){entered();await new Promise<void>(r=>{release=r});}};
 const s=f.make();const pending=s.setup(input).catch(()=>{});await waiting;const stopped=s.disconnect();release();await Promise.all([pending,stopped]);
 expect(s.snapshot().phase).toBe("disconnected");expect(f.opens).toBe(0);expect(f.saved.enabled).toBe(false);expect(f.calls.every(c=>c.method==="GET")).toBe(true);
});
it("leaves ambiguous writes marked and does not replay them on restart",async()=>{
 const f=fixture();f.hook=async path=>{if(path==="/api/v1/api-keys")throw new Error("network broke after remote commit");};
 const s=f.make();await expect(s.setup(input)).rejects.toThrow();expect(f.saved.pending).toBe(true);f.calls.length=0;
 const second=f.make();await second.restore();expect(second.snapshot().phase).toBe("error");expect(f.calls).toHaveLength(0);
 await expect(second.reconnect()).rejects.toThrow("interrupted");expect(f.calls).toHaveLength(0);
});
it("does not take another active tunnel during reconnect",async()=>{
 const f=fixture(),s=f.make();await s.setup(input);await s.disconnect();f.connectedElsewhere=true;
 await expect(s.reconnect()).rejects.toThrow("elsewhere");expect(f.opens).toBe(1);expect(s.snapshot().phase).toBe("error");
});

it("resumes a saved subscription after router failure without creating more resources",async()=>{
 const f=fixture();f.hook=async path=>{if(path.endsWith("triage-number"))throw new Error("temporary offline");};
 const s=f.make();await expect(s.setup(input)).rejects.toThrow();expect(f.saved).toMatchObject({stage:"subscribed",pending:false});
 expect(s.snapshot().canReconnect).toBe(true);await s.close();f.hook=undefined;f.calls.length=0;
 const second=f.make();await second.restore();expect(second.snapshot().phase).toBe("awaiting_phone");
 expect(f.calls.every(c=>c.method==="GET")).toBe(true);expect(f.opens).toBe(1);
});
it("exposes scoped tools only for the bound bot and invalidates each runtime binding",async()=>{
 const f=fixture(),s=f.make();expect(s.toolConnection(botId)).toBeNull();await s.setup(input);
 const first=s.toolConnection(botId);expect(first).toMatchObject({identityId:id,apiKey:"runtime-key"});
 expect(s.toolConnection(id)).toBeNull();expect(JSON.stringify(s.snapshot())).not.toContain(first!.binding);
 await s.disconnect();expect(s.toolConnection(botId)).toBeNull();await s.reconnect();
 expect(s.toolConnection(botId)!.binding).not.toBe(first!.binding);
 await s.close();expect(s.toolConnection(botId)).toBeNull();
});
it("does not mistake a recorded call from the owner number for verified chat readiness",async()=>{
 const f=fixture(),s=f.make();await s.setup(input);
 f.delivery=[{id:"call",sender:input.ownerPhone,channel:"calls",status:"recorded"}];
 expect(s.snapshot().phase).toBe("awaiting_phone");
});
it("upgrades a saved iMessage subscription without replacing identity or secrets",async()=>{
 const f=fixture(),s=f.make();await s.setup(input);await s.close();
 delete f.saved.broadEvents;const before={...f.saved};f.calls.length=0;
 const second=f.make();await second.restore();
 expect(second.snapshot().capabilitiesAvailable).toBe(true);
 expect(f.saved).toMatchObject({identityId:before.identityId,apiKey:before.apiKey,signingSecret:before.signingSecret,subscriptionId:before.subscriptionId,broadEvents:true});
 expect(f.calls.filter(c=>c.method!=="GET")).toEqual([expect.objectContaining({method:"PATCH",path:`/api/v1/webhooks/subscriptions/${id}`,body:{event_types:expect.arrayContaining(["imessage.received","message.received","slack.dm_received"])}})]);
});
it("keeps the original runtime when an additional subscription cannot be reconciled",async()=>{
 const f=fixture(),s=f.make();await s.setup(input);await s.close();delete f.saved.broadEvents;
 f.hook=async path=>{if(path===`/api/v1/webhooks/subscriptions/${id}`)throw new Error("unavailable");};
 const second=f.make();await second.restore();
 expect(second.snapshot()).toMatchObject({phase:"awaiting_phone",capabilitiesAvailable:true,eventSubscriptionError:expect.any(String)});
 expect(f.saved.broadEvents).toBeUndefined();
});
