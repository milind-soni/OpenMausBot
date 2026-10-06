import { expect, it } from "vitest";
import { InkboxProvider, INKBOX_RECEIVED_EVENTS } from "./inkbox-provider.ts";
const id = "a1111111-1111-4111-8111-111111111111";
const tunnelId = "c1111111-1111-4111-8111-111111111111";
const tunnel = { id:tunnelId, tunnel_name:"maus-test", agent_identity_id:id, public_host:"maus-test.inkboxwire.com", tls_mode:"edge", status:"active", zone:"inkboxwire.com" };
const identity = { id, agent_handle: "maus-test", status: "active", imessage_enabled: true, signing_key_configured: false,
  tunnel };
function fixture(body: unknown, status = 200) { const calls: Array<{url: string; init?: RequestInit}> = []; const provider = new InkboxProvider("secret", async (url, init) => { calls.push({url:String(url),init}); return Response.json(String(url).includes("/tunnels/") && status === 200 ? {...tunnel, currently_connected:false} : body, {status}); }); return {provider,calls}; }
it("uses fixed authenticated provider URLs, a timeout, and refuses redirects", async () => {
  const {provider,calls}=fixture({status:"active", scoped_identity_id:id});
  expect(await provider.inspectKey()).toEqual({status:"active",scoped_identity_id:id});
  expect(calls[0].url).toBe("https://inkbox.ai/api/v1/api-keys/self");
  expect(calls[0].init).toMatchObject({redirect:"error",headers:{"X-API-Key":"secret"}});
  expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
});
it("creates only an iMessage identity, without paid numbers or extra access", async () => {
  const {provider,calls}=fixture(identity,201); await provider.createIdentity("maus-test");
  expect(JSON.parse(calls[0].init!.body as string)).toEqual({agent_handle:"maus-test",display_name:"Mausbot",imessage_enabled:true});
});
it("rejects a substituted tunnel hostname or active tunnel", async () => {
  for (const tunnel of [{...identity.tunnel,public_host:"evil.example"},{...identity.tunnel,zone:"evil.example"}]) {
    await expect(fixture({...identity,tunnel}).provider.getIdentity("maus-test")).rejects.toThrow();
  }
});
it("narrows keys and refuses mismatched scope", async () => {
  const {provider,calls}=fixture({api_key:"runtime-secret",record:{id:"key",status:"active",scoped_identity_id:id}},201);
  expect(await provider.mintKey(id)).toBe("runtime-secret");
  expect(JSON.parse(calls[0].init!.body as string)).toMatchObject({scoped_identity_id:id});
  await expect(fixture({api_key:"wrong",record:{status:"active",scoped_identity_id:"other"}}).provider.mintKey(id)).rejects.toThrow();
});
it("validates router metadata and builds its own safe Messages link", async () => {
  const {provider}=fixture({number:"+15555550123",connect_command:"connect @maus-test",sms_link:"https://evil.example"});
  expect(await provider.router(id,"maus-test")).toEqual({number:"+15555550123",connectText:"connect @maus-test",smsLink:"sms:+15555550123?&body=connect%20%40maus-test"});
});
it("gets a scoped identity only when the provider binds it to the requested ID", async () => {
  expect(await fixture([identity]).provider.ownIdentity(id)).toEqual(identity);
  await expect(fixture([identity]).provider.ownIdentity("b1111111-1111-4111-8111-111111111111")).rejects.toThrow();
});
it("does not reflect provider error text or oversized payloads", async () => {
  await expect(fixture({error:"secret account detail"},403).provider.inspectKey()).rejects.toThrow("Inkbox rejected");
  await expect(fixture({data:"x".repeat(300000)}).provider.inspectKey()).rejects.not.toThrow("xxxx");
});
it("registers documented communication events and requires its one-time secret without rotating keys", async () => {
  const url="https://maus-test.inkboxwire.com/inkbox";
  const {provider,calls}=fixture({id,agent_identity_id:id,url,event_types:[...INKBOX_RECEIVED_EVENTS],signing_key:"sign-secret"},201);
  expect(await provider.subscribe(id,"maus-test")).toEqual({id,signingSecret:"sign-secret"});
  expect(JSON.parse(calls[0].init!.body as string)).toEqual({agent_identity_id:id,url,event_types:[...INKBOX_RECEIVED_EVENTS]});
  await expect(fixture({id,agent_identity_id:id,url,event_types:[...INKBOX_RECEIVED_EVENTS],signing_key:null},201).provider.subscribe(id,"maus-test")).rejects.toThrow("signing key");
});

it("reads documented live tunnel state separately from identity summaries", async () => {
  const {provider,calls}=fixture(identity);
  expect(await provider.getIdentity("maus-test")).toEqual(identity);
  expect(calls.map(call=>call.url)).toEqual(["https://inkbox.ai/api/v1/identities/maus-test",`https://inkbox.ai/api/v1/tunnels/${tunnelId}`]);
});
it("requires a matching inactive tunnel with known live state", async () => {
  for (const changed of [{currently_connected:true},{currently_connected:null},{currently_connected:undefined}, {agent_identity_id:tunnelId},{tunnel_name:"another-handle"},{id}, {tls_mode:"passthrough"},{status:"deleted"},{zone:"evil.example"}]) {
    const provider = new InkboxProvider("secret", async url=>Response.json(String(url).includes("/tunnels/") ? {...tunnel, currently_connected:false,...changed} : identity));
    await expect(provider.getIdentity("maus-test")).rejects.toThrow();
  }
});

it("discovers actual channel resources without provisioning or guessing a mailbox", async () => {
 const provider = new InkboxProvider("secret", async (url, init) => {
  expect(init?.method).toBe("GET");
  if (String(url).includes("/slack/connections")) return Response.json({connections:[{id:tunnelId,identity_id:id,workspace_id:"T123",workspace_name:"Team",status:"connected",bot_user_id:"U123",scopes:[]}],installation_available:true});
  if (String(url).endsWith("/a2a/settings")) return Response.json({enabled:true,card_url:"https://inkbox.ai/a2a/maus-test/card"});
  return Response.json({...identity,mailbox:{id:tunnelId,email_address:"agent@custom.example",agent_identity_id:id},phone_number:null});
 });
 const resources = await provider.resources("maus-test",id);
 expect(resources.find(r=>r.channel==="email")).toMatchObject({address:"agent@custom.example",status:"ready"});
 expect(resources.find(r=>r.channel==="sms")?.status).toBe("needs_setup");
 expect(resources.find(r=>r.channel==="slack")?.status).toBe("ready");
 expect(resources.find(r=>r.channel==="whatsapp")?.status).toBe("unavailable");
});
it("fails resource discovery closed on substituted channel ownership", async () => {
 const provider=new InkboxProvider("secret",async()=>Response.json({...identity,mailbox:{id:tunnelId,email_address:"agent@custom.example",agent_identity_id:tunnelId}}));
 await expect(provider.resources("maus-test",id)).rejects.toThrow();
});
it("extends only its exact subscription and preserves existing events and settings",async()=>{
 const calls:Array<{path:string;method:string;body:any}>=[];
 const provider=new InkboxProvider("secret",async(url,init)=>{
  calls.push({path:String(url),method:init?.method??"GET",body:init?.body?JSON.parse(String(init.body)):undefined});
  return Response.json({id:tunnelId,agent_identity_id:id,url:"https://maus-test.inkboxwire.com/inkbox",status:"active",event_types:init?.method==="PATCH"?JSON.parse(String(init.body)).event_types:["imessage.received","message.bounced"],auth_token:"untouched"});
 });
 await provider.extendSubscription(tunnelId,id,"maus-test");
 expect(calls).toHaveLength(2);expect(calls[1].path).toContain("?scope=identity");
 expect(calls[1].body.event_types).toContain("message.bounced");expect(calls[1].body.event_types).toContain("message.received");
 expect(Object.keys(calls[1].body)).toEqual(["event_types"]);
});
